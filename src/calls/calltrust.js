// Who Reason trusts on a call (owner decision 2026-11-13). REASON_CALL_TRUST = off | owner | on, default
// off; off is today exactly (./verify.js: caller ID is never trusted, anything consequential waits for a
// text after the call). On, three levels, decided here from the tool being called, never by the model:
//
//   LOW         caller ID is enough. On an inbound call from the account's own number (never a contact's,
//               a withheld one, a forwarded one, one whose carrier check failed, never with another person
//               on the line, never a call Reason placed): a calendar event on their own calendar with no
//               invitees, a free booking (the page shows no price, deposit, card or fee), a voice note to
//               themselves. Reminders, notes, lists, lookups and a text to themselves were never held.
//   PASSPHRASE  asked for at that moment, for that one action: anything that reaches another person,
//               a change or a delete, a booking with a cancellation or no-show fee, reading out codes or
//               money details. Fixed words: "Say your passphrase and I'll do it now, or I'll do it by text
//               right after." The next thing they say is checked in code (src/callpass.js) and replaced
//               by a marker before it is kept anywhere; a match unlocks that one action for a few
//               minutes; a miss gets one more try, then the text after the call. Three tries a call.
//   TEXT        money and saved logins, and anything consequential not named below: never by voice,
//               passphrase or not. The existing Face ID or typed yes in their thread, after the call.
//
// The relays (./cartesia.js, ./gptlive.js) call `listening` after each of Reason's replies and `hear`
// on the caller's next words; ./voice.js calls `decide` in front of every tool and `owedLine` at the
// start of each turn.
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import { clock, normalizeNumber } from "../config.js";
import * as callpass from "../callpass.js";
import * as verify from "./verify.js";
import { currentParty } from "./hold.js";

export const LEVEL = Object.freeze({ OPEN: "open", LOW: "low", PASSPHRASE: "passphrase", TEXT: "text" });

/** The spoken lines, fixed in code. Short and plain; none offers to try again. */
export const LINES = Object.freeze({
  ask: "Say your passphrase and I'll do it now, or I'll do it by text right after.",
  missAgain: "That's not it. Say it once more, or I'll do it by text right after.",
  missLast: "That's not it either, so I'll do that one by text right after the call.",
  notice: "I'll do this one by text after the call. If you set a call passphrase, next time I can do it right away: say 'set my passphrase' now, or text me 'set my call passphrase'.",
  setupAsk: "Go ahead: say a phrase of three words or more.",
  setupShort: "That needs at least three words. Say a longer one, or text me 'set my call passphrase'.",
  setupGiveUp: "Let's do it by text instead: text me 'set my call passphrase'.",
  setupHaveOne: "You already have one. To change it, text me 'change my call passphrase'.",
  setupReadBack: (n, first) => `Got it: ${n} words, starting with "${first}". I'll text you to turn it on.`,
});
/** What is kept in place of what they said: the transcript, turn_log, the thread and Reason's next turn. */
export const MARKER = "[they said their call passphrase here; the words are not kept]";
export const SETUP_MARKER = "[they said a new call passphrase here; the words are not kept]";
const READBACK_KEPT = /(Got it: \d+ words, starting with ")[^"]*(")/g;
/** Reason's read-back as kept: the first word is said on the call, never written down. */
export const scrubSaid = (text) => String(text ?? "").replace(READBACK_KEPT, "$1…$2");

/** How long a match unlocks its one action. */
export const GRANT_MS = 5 * 60_000;
export const MAX_TRIES_PER_CALL = 3;
export const MAX_TRIES_PER_ASK = 2;
/** The notice is said once, then at most once more, ever, per person. */
export const MAX_TOLD = 2;

// ---------------------------------------------------------------- the levels
/** Consequential tools a passphrase may unlock: they reach somebody else, change or delete something. */
export const PASSPHRASE_TOOLS = new Set([
  "message_send", "voice_note_send", "call_place", "make_a_call_for_me", "gmail_send", "drive_share",
  "x_post", "x_reply", "x_retweet", "x_like", "x_unlike", "x_bookmark", "x_bookmark_remove", "x_dm", "x_delete",
  "github_issue_create", "github_issue_comment", "event_blast", "event_schedule",
  "gmail_trash", "gmail_archive", "gmail_mark", "gmail_label", "drive_trash", "drive_move", "call_recording_delete",
  "call_hours_set",
]);
/** Not held on a call today and held with the switch on: deletes and changes to what already exists. */
export const NOW_HELD = new Set(["calendar_change", "calendar_delete", "apple_calendar_change", "apple_calendar_delete", "document_delete", "page_delete"]);
/** Reads whose answer is money or travel-document detail: said aloud only after the passphrase. */
export const SENSITIVE_READS = new Set(["ledger_list", "purchases_recent", "uber_receipt", "boarding_pass", "flight_travelers", "spend_today"]);
/** Never by voice: money, saved logins and sign-ins, the gate itself, plans that may spend, operator tools. */
export const TEXT_ONLY = new Set([
  "purchase_confirm", "purchase", "uber_request", "uber_cancel", "event_refund", "event_ticket_refund", "event_seats", "flight_book", "pay_by_phone",
  "account_connect", "account_revoke", "vault_enroll", "subscription_cancel_commit", "flight_checkin_commit", "todo_approve",
  "permission_grant", "caps_set", "spend_limit_set", "spend_limit_confirm",
  "remote_approve", "github_pr_merge", "admin_delete",
]);

/** A one-time code in a tool's answer: never read out without the passphrase. */
const CODE_IN = /\b(?:code|passcode|otp|pin|verification|one[- ]time)\b[^\n]{0,40}?\b\d{4,8}\b|\b\d{4,8}\b[^\n]{0,30}\b(?:is your|verification|code)\b/i;
export const hasCode = (out) => CODE_IN.test(typeof out === "string" ? out : JSON.stringify(out ?? ""));

const PAYS = /\b(?:card(?:\s+(?:number|on file|details))?|credit|debit|cvv|cvc|security code|expir(?:y|ation)|billing|pay(?:ment)?|deposit|pre-?pay|charged?|total|amount due|checkout|subtotal|buy|purchase|order now|apple pay|google pay|paypal)\b|[$£€]\s?\d/i;
const PENALTY = /\b(?:cancell?ation fee|no[- ]show fee|late (?:cancell?ation|arrival) fee|cancell?ation policy|penalty|fee (?:if|for) (?:you )?(?:cancel|miss))\b/i;
/**
 * What committing this page would do: "free" (nothing about money anywhere), "fee" (a cancellation or
 * no-show penalty and nothing else about money), "pays" (a price, card, deposit or payment). No page to
 * read is "pays": what cannot be seen is never low risk.
 */
export function bookingKind(what = "", page = null) {
  if (page == null || !String(page).trim()) return "pays";
  const lines = `${what}\n${page}`.split(/\n|(?<=[.!?])\s+/);
  let fee = false;
  for (const l of lines) {
    if (PENALTY.test(l)) { fee = true; continue; }
    if (PAYS.test(l)) return "pays";
  }
  return fee ? "fee" : "free";
}

const invitees = (input) => [].concat(input?.attendees ?? [], input?.invitees ?? [], input?.guests ?? []).filter(x => String(x ?? "").trim()).length > 0;

/**
 * The level of one tool call. `toSelf(to)`: is this addressed to the person themself. `page`: the open
 * page's text, for a booking. `confirmation`: the row a confirm_record is recording.
 */
export function levelOf(name, input = null, { toSelf = () => false, page = null, confirmation = null } = {}) {
  const n = String(name ?? "");
  if (n === "confirm_record") {
    if (!confirmation) return LEVEL.TEXT;
    if (/money/i.test(String(confirmation.stakes ?? "")) || Number(confirmation.amount ?? confirmation.amount_cents ?? 0) > 0) return LEVEL.TEXT;
    return levelOf(confirmation.action, { what: confirmation.target || confirmation.summary, to: confirmation.target }, { toSelf, page });
  }
  if (TEXT_ONLY.has(n)) return LEVEL.TEXT;
  if (n === "browser_submit") {
    const k = bookingKind(input?.what ?? "", page);
    return k === "free" ? LEVEL.LOW : k === "fee" ? LEVEL.PASSPHRASE : LEVEL.TEXT;
  }
  if (n === "calendar_create") return invitees(input) ? LEVEL.PASSPHRASE : LEVEL.LOW;
  // A call placed on their behalf (./fromcall.js go): it reaches the person it rings.
  if (n === "make_a_call_for_me") return LEVEL.PASSPHRASE;
  if (n === "voice_note_send" && input && toSelf(input.to)) return LEVEL.LOW;
  if (NOW_HELD.has(n) || SENSITIVE_READS.has(n)) return LEVEL.PASSPHRASE;
  if (!verify.isConsequential(n, input, { toSelf })) return LEVEL.OPEN;
  if (PASSPHRASE_TOOLS.has(n) || verify.reachesGuests(n, input)) return LEVEL.PASSPHRASE;
  return LEVEL.TEXT;
}

// ---------------------------------------------------------------- caller ID
/** Is the switch on for this call's person (an own call only)? */
export const trustOn = (call) => Boolean(call?.is_owner) && callpass.callTrustFor(call?.conversation_id);

/**
 * Does the number this call came from count, on its own, for the low level? Only an inbound own call,
 * from exactly the number the account is registered with (the operator: one of the configured operator
 * numbers), not forwarded, no failed carrier check, one person on the line, on the relays that screen
 * what is said (GPT-Live and the Cartesia bridge, both `gptlive` rows).
 */
export function callerIdTrusted(call) {
  if (!call?.is_owner || String(call.direction ?? "out") !== "in") return false;
  if (String(call.provider ?? "") !== "gptlive") return false;
  if (String(call.caller_forwarded ?? "").trim()) return false;
  if (/fail/i.test(String(call.caller_attest ?? ""))) return false;
  if (currentParty(call) > 1) return false;
  const from = normalizeNumber(call.to_number);
  if (!/^\+\d{8,15}$/.test(from)) return false;
  let acct = null, me = null;
  try { acct = db.getAccount(call.conversation_id); me = accounts.ownerOf(call.conversation_id); } catch { return false; }
  if (me?.isOperator) return accounts.isOperatorAddress(from);
  const own = normalizeNumber(acct?.address);
  return Boolean(own) && own === from;
}

// ---------------------------------------------------------------- the row
const json = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
/** The row as the database has it now, as a copy: a relay's own call object is never changed here. */
function fresh(call) {
  try { const r = db.getCall(call.conversation_id, call.id); if (r) return { ...call, ...r }; } catch { /* the object as it is */ }
  return { ...call };
}
function put(call, fields) {
  try { const r = db.updateCall(call.conversation_id, call.id, fields); if (r) Object.assign(call, r); } catch { /* never breaks a call */ }
}

/** The action a match unlocked, while it is unlocked. */
export function grantFor(call, now = clock.now()) {
  const g = json(call?.trust_grant);
  return g && !g.used && Number(g.until) > now ? g : null;
}
/** A tool ran: the one action a passphrase unlocked is spent once it has run (ok). */
export function ran(call, name, out, { log = () => {} } = {}) {
  if (!trustOn(call)) return;
  const row = fresh(call);
  const g = grantFor(row);
  if (!g || g.action !== String(name) || out?.ok === false) return;
  put(call, { trust_grant: JSON.stringify({ ...g, used: true }) });
  // It ran on the call: it is not waiting for the text any more.
  try {
    const parts = String(row.verify_deferred ?? "").split("; ").filter(p => p && p !== g.what);
    put(call, { verify_deferred: parts.join("; ") });
  } catch { /* the after-call text asks again, harmlessly */ }
  log({ call_trust_grant_used: call.id, tool: g.action });
}

// ---------------------------------------------------------------- the gate (./voice.js)
/**
 * In front of one tool on an own call that is not verified. Null when the switch is off for this call:
 * the caller then does exactly what it did before. Otherwise { allow } or { allow: false, out, line }.
 */
export function decide({ call, name, input = null, toSelf = () => false, page = null, now = clock.now(), log = () => {} }) {
  if (!trustOn(call)) return null;
  const n = String(name ?? "");
  let confirmation = null;
  if (n === "confirm_record") { try { confirmation = db.getConfirmation(call.conversation_id, input?.confirmation_id); } catch { /* none */ } }
  const level = levelOf(n, input, { toSelf, page, confirmation });
  if (level === LEVEL.OPEN) return { allow: true, level };
  const forAction = n === "confirm_record" ? (confirmation?.action ?? n) : n;
  if (level === LEVEL.TEXT) return refuse({ call, name: forAction, input, level, line: null, log });
  const trusted = callerIdTrusted(call);
  if (level === LEVEL.LOW && trusted) { log({ call_trust_low: call.id, tool: n }); return { allow: true, level }; }
  // One action, unlocked by a match a moment ago (confirm_record for that action's own yes too).
  const g = grantFor(fresh(call), now);
  if (g && g.action === forAction && trusted) return { allow: true, level, granted: true };
  if (!trusted) return refuse({ call, name: forAction, input, level, line: null, log });
  return askFor({ call, name: forAction, input, now, log });
}

function refuse({ call, name, input, level, line, log, asked = false }) {
  // Queued for the text after the call either way: "or I'll do it by text right after" stays true.
  const out = verify.gateRefusal({ call, name, input, expected: "", log });
  if (line) {
    out.say = `Not yet. Say exactly this, and nothing else: "${line}" Do not run ${name} now.`;
    out.blocked = asked ? "needs_passphrase" : out.blocked;
  } else if (level === LEVEL.TEXT) {
    out.say = `${out.say} This is never done by voice, passphrase or not.`;
  }
  return { allow: false, level, out, line };
}

/** A tool's answer with a one-time code in it is held like a sensitive read (switch on only). */
export function holdsCode({ call, name, out, now = clock.now(), log = () => {} }) {
  if (!trustOn(call) || !hasCode(out)) return null;
  const g = grantFor(fresh(call), now);
  const trusted = callerIdTrusted(call);
  if (g && g.action === String(name) && trusted) return null;
  log({ call_trust_code_held: call.id, tool: String(name) });
  if (!trusted) return refuse({ call, name: String(name), input: null, level: LEVEL.PASSPHRASE, line: null, log });
  return askFor({ call, name: String(name), input: null, now, log });
}

function askFor({ call, name, input, now, log }) {
  const c = call.conversation_id;
  if (!callpass.hasPassphrase(c, now)) {
    if (!Number(call.trust_told) && callpass.toldCount(c) < MAX_TOLD) {
      callpass.noteTold(c); put(call, { trust_told: 1 });
      return refuse({ call, name, input, level: LEVEL.PASSPHRASE, line: LINES.notice, log });
    }
    return refuse({ call, name, input, level: LEVEL.PASSPHRASE, line: null, log });
  }
  if (Number(call.trust_tries ?? 0) >= MAX_TRIES_PER_CALL || callpass.lockedOut(c, now)) return refuse({ call, name, input, level: LEVEL.PASSPHRASE, line: null, log });
  put(call, { trust_ask: JSON.stringify({ action: name, what: verify.describeAsk(name, input), misses: 0, state: "asked", at: now }) });
  log({ call_trust_asked: call.id, tool: name });
  return refuse({ call, name, input, level: LEVEL.PASSPHRASE, line: LINES.ask, log, asked: true });
}

// ---------------------------------------------------------------- the ear (./cartesia.js, ./gptlive.js)
/** What the caller's next words are for: "pass" (a passphrase), "setup" (a new one), or null. */
export function listening(call) {
  if (!trustOn(call)) return null;
  const row = fresh(call);
  if (json(row.trust_ask)?.state === "asked") return "pass";
  if (json(row.trust_setup)?.state === "asked") return "setup";
  return null;
}

/**
 * The caller's words while `listening`: checked here, and what is kept in their place returned
 * ({ text: MARKER }). The words go no further than this function and src/callpass.js.
 */
export function hear(callIn, text, { now = clock.now(), log = () => {} } = {}) {
  const kind = listening(callIn);
  const call = fresh(callIn);
  if (!kind || !String(text ?? "").trim()) return null;
  const c = call.conversation_id;
  if (kind === "setup") {
    const s = json(call.trust_setup) ?? {};
    if (callpass.hasPassphrase(c, now)) { put(call, { trust_setup: JSON.stringify({ ...s, state: "done" }), trust_owed: LINES.setupHaveOne }); return { text: SETUP_MARKER, kind }; }
    const set = callpass.normalWords(text).length >= callpass.MIN_WORDS ? callpass.setPending(c, text, { callId: call.id, now }) : null;
    if (set) {
      put(call, { trust_setup: JSON.stringify({ ...s, state: "set", at: now }), trust_owed: LINES.setupReadBack(set.words, set.first) });
      log({ call_trust_setup: call.id, words: set.words });
    } else {
      const misses = Number(s.misses ?? 0) + 1;
      put(call, { trust_setup: JSON.stringify({ ...s, misses, state: misses < 2 ? "asked" : "done" }), trust_owed: misses < 2 ? LINES.setupShort : LINES.setupGiveUp });
      log({ call_trust_setup_short: call.id, misses });
    }
    return { text: SETUP_MARKER, kind };
  }
  const ask = json(call.trust_ask) ?? {};
  const tries = Number(call.trust_tries ?? 0) + 1;
  const got = callpass.check(c, text, now);
  if (got) {
    put(call, {
      trust_tries: tries,
      trust_ask: JSON.stringify({ ...ask, state: "matched" }),
      trust_grant: JSON.stringify({ action: ask.action, what: ask.what, until: now + GRANT_MS, used: false }),
      trust_owed: "",
    });
    log({ call_trust_passphrase: call.id, ok: true, near: got === "near", tries });
    return { text: MARKER, kind, ok: true };
  }
  const locked = callpass.noteMiss(c, now);
  const misses = Number(ask.misses ?? 0) + 1;
  const again = misses < MAX_TRIES_PER_ASK && tries < MAX_TRIES_PER_CALL && !locked;
  put(call, { trust_tries: tries, trust_ask: JSON.stringify({ ...ask, misses, state: again ? "asked" : "failed" }), trust_owed: again ? LINES.missAgain : LINES.missLast });
  log({ call_trust_passphrase: call.id, ok: false, tries, locked });
  return { text: MARKER, kind, ok: false };
}

/** "set my passphrase" said on the call. */
const SET_ON_CALL = /\b(?:set|make|create)\s+(?:up\s+)?(?:my|a)\s+(?:call\s+)?pass\s?phrase\b/i;

/**
 * At the start of Reason's turn: a line code owes now (after a check, or for a set-up), said instead of
 * a model turn. Null when there is none.
 */
export function owedLine(call, { theirWords = "", now = clock.now(), log = () => {} } = {}) {
  if (!trustOn(call)) return null;
  Object.assign(call, fresh(call));
  const owed = String(call.trust_owed ?? "");
  if (owed) { put(call, { trust_owed: "" }); log({ call_trust_said: call.id }); return owed; }
  if (SET_ON_CALL.test(String(theirWords)) && callerIdTrusted(call) && json(call.trust_setup)?.state !== "set") {
    if (callpass.hasPassphrase(call.conversation_id, now)) return LINES.setupHaveOne;
    put(call, { trust_setup: JSON.stringify({ state: "asked", misses: 0, at: now }) });
    log({ call_trust_setup_asked: call.id });
    return LINES.setupAsk;
  }
  return null;
}

/** For the own-call prompt (./voice.js), replacing verify.promptNote when the switch is on. */
export function promptNote(call, now = clock.now()) {
  if (verify.isVerified(call)) return "";
  const g = grantFor(call, now);
  const unlocked = g ? ` Their passphrase matched a moment ago: do ${String(g.action).replace(/_/g, " ")} now, as they asked. That one thing only.` : "";
  return `--- what this call can do ---\n`
    + `Talk, look things up, set reminders, notes and lists, put things on their own calendar and make free bookings`
    + ` exactly as usual. Some things need one more step, and code decides which: when a tool says so, say its words`
    + ` exactly. Never ask for a passphrase yourself, never repeat, spell or hint at one, and never say what they said`
    + ` when a passphrase is marked in the conversation.${unlocked}`;
}

/** For the voice's own instructions (GPT-Live and the Cartesia agent), switch on only. */
export function voiceLines(call) {
  if (!trustOn(call)) return "";
  return "If they say a passphrase, never repeat, spell, confirm or say back any of its words, now or later in the call."
    + " Hand it to Reason with only the words 'they said their passphrase' (or 'they said a new passphrase'), never the phrase itself.";
}

/** The relays' request text right after a screened passphrase: never the voice's copy of it. */
export const SCREENED_REQUEST = "they said their passphrase";

// ---------------------------------------------------------------- after the call
/** A phrase set on this call: the one text that asks for the typed yes (./gptlive.js settle). */
export function afterCall(row, { queue, log = () => {} } = {}) {
  try {
    if (!row?.id || !trustOn(row)) return null;
    if (json(row.trust_setup)?.state !== "set") return null;
    const p = callpass.pendingFor(row.conversation_id);
    if (!p || Number(p.callId) !== Number(row.id) || p.askedOutbox) return null;
    const r = queue({ call: row, text: callpass.WORDS.activateAsk, kind: "passphrase_yes", log });
    if (r?.outbox_id) callpass.notePendingAsked(row.conversation_id, r.outbox_id);
    log({ call_trust_activate_asked: row.id, ok: !!r?.ok });
    return r;
  } catch { return null; }
}
