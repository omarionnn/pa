// A check-in they set up may read their bank, with their say-so (owner decision 2026-11-14).
//
// Their bank is read only on a turn they started with their own words (src/tools.js, case "bank").
// A timer is not that, so a daily "recap my spending" check-in met `not_asked` and sent nothing.
// This file is the one exception, and it is narrow on purpose:
//
//   - A STANDING GRANT is bound to ONE standing thing: a series (`series:<id>`) or a timer, a chain
//     of timers counted as its first one (`timer:<id>`). Nothing else can use it: the key is worked
//     out in code from the firing timer's own row (ctx.fromTimer, set by src/runtime.js _runTimer),
//     never from anything the model passes.
//   - It is made only by the person's own typed yes (src/trust.js ownerTexts: never an attachment, a
//     page, an email, an event line, a call that was not verified, another person) on their own turn,
//     answering Reason's fixed ask, which must be the last thing Reason said before it. Groups never
//     reach a turn at all (src/channels/sendblue.js, linq.js drop them), and a call is refused here.
//   - What it covers is read-only and small: `balance`, `spending`, `transactions`, for the periods
//     the check-in's own words name (a daily one: today and yesterday). Kept on the row with the exact
//     words that were asked and when.
//   - When it is asked: in the reply that sets up a check-in whose words are about their money (if a
//     bank is connected), or at the first firing of one that has no answer yet: then code sends ONE
//     fixed line, the bank is not read that time, and nothing else is said. Asked once per standing
//     thing; a no is kept, and the check-in then runs without bank data.
//   - It goes when the check-in is ended or cancelled, when they say "stop reading my bank" or
//     disconnect their last bank, and with their data (src/data.js).
import * as db from "./db.js";
import { clock } from "./config.js";
import { ownerTexts } from "./trust.js";
import { isBareYes } from "./namedsite.js";
import { isBareRefusal } from "./trust.js";

db.db.exec(`
  -- One check-in's permission to read their bank (src/bankgrant.js). standing is series:<id> or
  -- timer:<id>; state asked | granted | declined; words is the exact line they were shown; actions
  -- and periods (JSON) are what a firing may read; note says how the answer was given.
  CREATE TABLE IF NOT EXISTS bank_checkin_grants (
    conversation_id TEXT NOT NULL,
    standing TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'asked',
    words TEXT NOT NULL DEFAULT '',
    actions TEXT NOT NULL DEFAULT '[]',
    periods TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    asked_at INTEGER,
    decided_at INTEGER,
    -- The check-in's own words when it was asked or granted: words changed since drop the answer.
    standing_words TEXT NOT NULL DEFAULT '',
    -- The bank connections (Plaid item ids, JSON) a yes covered: a bank connected later needs a new yes.
    items TEXT NOT NULL DEFAULT '[]',
    -- When a firing asked (the once-owed "I didn't read it"), and when the one reminder went.
    fired_asked_at INTEGER,
    reminded_at INTEGER,
    UNIQUE (conversation_id, standing)
  );
`);
const q = (sql) => db.db.prepare(sql);

// ---------------------------------------------------------------- the fixed words
// Each ask names the check-in it is for, so a yes is to something they could see; the yes is then bound
// to the ask whose words end the thread just before it (answeredAsk).
export const ASK_SETUP = "This will read your bank each time it runs. OK to do that every time?";
export const ASK_FIRED = "This check-in needs your OK to read your bank, so I didn't read it this time. OK to read your bank every time it runs?";
const nameOf = (what) => {
  const s = String(what ?? "").replace(/\s+/g, " ").replace(/["\u201c\u201d]/g, "").trim();
  return s.length > 60 ? `${s.slice(0, 57).trimEnd()}...` : s;
};
export const askSetupLine = (what) => nameOf(what) ? `This check-in ("${nameOf(what)}") will read your bank each time it runs. OK to do that every time?` : ASK_SETUP;
export const askFiredLine = (what) => nameOf(what) ? `Your check-in "${nameOf(what)}" needs your OK to read your bank, so I didn't read it this time. OK to read your bank every time it runs?` : ASK_FIRED;
export const askNewBankLine = (what) => `You've connected another bank since you said your check-in "${nameOf(what) || "this one"}" could read your bank, so I didn't read it this time. OK to read your banks every time it runs?`;
export const remindLine = (what) => `Your check-in "${nameOf(what) || "this one"}" is still waiting on your OK to read your bank. OK to read it every time it runs?`;
export const SAID_YES = "OK, I'll read your bank each time this check-in runs. Say \"stop reading my bank\" anytime and I'll stop.";
export const SAID_NO = "OK, this check-in won't read your bank.";
export const STOPPED = "Done. That check-in won't read your bank anymore.";
export const FAILED_LINE = "I couldn't read your bank for this check-in just now, so there's no recap this time.";
export const RECONNECT_LINE = "I couldn't read your bank for this check-in: your bank needs you to sign in again. Text me \"reconnect my bank\" and I'll send the link.";
/** Read-only and nothing more: no connect link, no disconnect, no subscriptions list. */
export const ACTIONS = ["balance", "spending", "transactions"];
/** A yes counts only this soon after the ask it answers; later, the ask is shown again. */
export const ASK_TTL_MS = 15 * 60_000;
/** An ask still unanswered this long after a firing asked: one reminder at the next firing, then quiet. */
export const REMIND_AFTER_MS = 24 * 3600_000;

/** Words about their money: a check-in saying any of these asks before it reads their bank. */
const MONEY_RE = /\b(bank|banking|spend|spending|spent|transactions?|purchases?|charges?|balances?|budget|expenses?|money|plaid)\b/i;
export const aboutMoney = (words) => MONEY_RE.test(String(words ?? ""));

/** The periods a check-in's own words name. A daily one reads today and yesterday; nothing older than a month. */
export function periodsFor(words) {
  const w = String(words ?? "").toLowerCase();
  const out = new Set();
  if (/\bweek(ly|s)?\b|\bweekend\b/.test(w)) { out.add("this_week"); out.add("last_week"); }
  if (/\bmonth(ly|s)?\b/.test(w)) { out.add("this_month"); out.add("last_month"); }
  if (!out.size || /\b(today|tonight|daily|every ?day|each day|nightly|day'?s|yesterday)\b/.test(w)) { out.add("today"); out.add("yesterday"); }
  return [...out];
}

// ---------------------------------------------------------------- which standing thing
/** The first timer of a chain Reason keeps going (chained_from), so every link shares one key. */
function chainRoot(c, t) {
  let cur = t;
  for (let i = 0; i < 1000 && cur?.chained_from != null; i++) {
    const up = db.getTimer(c, cur.chained_from);
    if (!up) break;
    cur = up;
  }
  return cur;
}
/** The standing thing a timer belongs to, and its own words. Code's, from the rows. → { key, words } | null */
export function standingOf(c, timerOrId) {
  const t = typeof timerOrId === "object" && timerOrId ? timerOrId : db.getTimer(c, Number(timerOrId));
  if (!t || t.conversation_id !== c) return null;
  if (t.series_id != null) {
    const s = db.seriesById(t.series_id);
    if (!s || s.conversation_id !== c) return null;
    return { key: `series:${s.id}`, words: String(s.what ?? ""), live: s.state === "active" };
  }
  const root = chainRoot(c, t);
  return { key: `timer:${root.id}`, words: String(root.note ?? ""), live: !t.cancelled_at };
}

// ---------------------------------------------------------------- rows
const view = (r) => r ? { ...r, actions: JSON.parse(r.actions || "[]"), periods: JSON.parse(r.periods || "[]") } : null;
export const grantOf = (c, key) => view(q("SELECT * FROM bank_checkin_grants WHERE conversation_id = ? AND standing = ?").get(c, key));
export const grantsOf = (c) => q("SELECT * FROM bank_checkin_grants WHERE conversation_id = ? ORDER BY asked_at").all(c).map(view);

/** Their bank connections now (Plaid item ids), read straight off the rows. */
function bankItems(c) {
  try { return q("SELECT item_id FROM plaid_items WHERE conversation_id = ? AND status != 'removing' ORDER BY item_id").all(c).map(r => String(r.item_id)); } catch { return []; }
}

/**
 * The ask was shown: kept so the yes can be matched to it. Never overwrites an answer. `kind` is
 * setup | fired | reminder; `standingWords` the check-in's own words it was about.
 */
export function noteAsked(c, key, words, { kind = "setup", standingWords = "" } = {}) {
  const now = clock.now();
  q(`INSERT INTO bank_checkin_grants (conversation_id, standing, state, words, asked_at, standing_words, fired_asked_at, reminded_at) VALUES (?, ?, 'asked', ?, ?, ?, ?, ?)
     ON CONFLICT (conversation_id, standing) DO UPDATE SET words = excluded.words, asked_at = excluded.asked_at, standing_words = excluded.standing_words,
       fired_asked_at = COALESCE(excluded.fired_asked_at, fired_asked_at), reminded_at = COALESCE(excluded.reminded_at, reminded_at) WHERE state = 'asked'`)
    .run(c, key, String(words), now, String(standingWords), kind === "fired" ? now : null, kind === "reminder" ? now : null);
}
function decide(c, key, state, { words, standingWords = "", note }) {
  const periods = state === "granted" ? periodsFor(standingWords) : [];
  const actions = state === "granted" ? ACTIONS : [];
  const items = state === "granted" ? bankItems(c) : [];
  q(`INSERT INTO bank_checkin_grants (conversation_id, standing, state, words, actions, periods, note, asked_at, decided_at, standing_words, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (conversation_id, standing) DO UPDATE SET state = excluded.state, words = excluded.words, actions = excluded.actions, periods = excluded.periods, note = excluded.note, decided_at = excluded.decided_at, standing_words = excluded.standing_words, items = excluded.items`)
    .run(c, key, state, String(words), JSON.stringify(actions), JSON.stringify(periods), String(note), clock.now(), clock.now(), String(standingWords), JSON.stringify(items));
  return grantOf(c, key);
}

/**
 * The answer that still holds for this standing thing, or null. An answer given to other words than the
 * check-in has now is dropped (asked again); a yes given before a bank they connected since is dropped
 * too (`newBank`): it covered the banks there were then, and every read spans all of them.
 */
const NEW_BANK_NOTE = "a bank was connected after their yes";
function current(c, s) {
  const g = grantOf(c, s.key);
  if (!g) return { row: null };
  if (g.state !== "asked" && g.standing_words !== s.words) { revoke(c, s.key); return { row: null }; }
  if (g.state === "granted") {
    const had = new Set(JSON.parse(g.items || "[]"));
    if (bankItems(c).some(id => !had.has(id))) {
      q(`UPDATE bank_checkin_grants SET state = 'asked', actions = '[]', periods = '[]', items = '[]', note = ?, fired_asked_at = NULL, reminded_at = NULL WHERE conversation_id = ? AND standing = ?`).run(NEW_BANK_NOTE, c, s.key);
      return { row: grantOf(c, s.key) };
    }
  }
  return { row: g };
}
export function revoke(c, key) { return q("DELETE FROM bank_checkin_grants WHERE conversation_id = ? AND standing = ?").run(c, key).changes; }
export function revokeAll(c) { return q("DELETE FROM bank_checkin_grants WHERE conversation_id = ?").run(c).changes; }
/** A timer called off: a one-off's or a chain's own key goes with it (a series keeps its own until it ends). */
export function revokeForTimer(c, timer) {
  if (!timer || timer.series_id != null) return 0;
  return revoke(c, `timer:${chainRoot(c, timer).id}`);
}

/**
 * The owner's own CLI (scripts/bank-checkin-grant.js): a yes the operator gave in person, recorded for
 * one standing thing of the operator's own account. The caller checks it is the operator.
 */
export function recordOwnerYes(c, key, { standingWords, note }) {
  // The same rule as everyone's: the words and the banks it covers are those of today.
  return decide(c, key, "granted", { words: "(given to the operator directly)", standingWords, note });
}

// ---------------------------------------------------------------- the asks
/** At set-up, on their own turn: the line to add to the reply, or null. Recorded as asked. */
export function askAtSetup(c, key, words, { kind, bankConnected }) {
  if (kind !== "user" || !bankConnected || !aboutMoney(words)) return null;
  const had = grantOf(c, key);
  if (had && had.state !== "asked") return null;
  const line = askSetupLine(words);
  noteAsked(c, key, line, { kind: "setup", standingWords: String(words ?? "") });
  return line;
}
/**
 * At a firing (src/runtime.js, sent right after the turn so it is the last thing in the thread): the
 * line to send, or null. Only for a check-in whose own words are about their money, with a bank
 * connected, not answered. The first firing asks (also the honest "I didn't read it this time"); a
 * firing at least REMIND_AFTER_MS after that, still unanswered, sends ONE reminder; then nothing more.
 * Recorded with noteAsked({ kind }) when the line has gone.
 */
export function askAtFire(c, timer, { bankConnected, now = clock.now() }) {
  const s = standingOf(c, timer);
  if (!s || !bankConnected || !aboutMoney(s.words)) return null;
  const had = current(c, s).row;
  if (had && had.state !== "asked") return null;
  const ask = { key: s.key, words: s.words };
  if (!had || !had.fired_asked_at || had.standing_words !== s.words) return { ...ask, kind: "fired", line: had?.note === NEW_BANK_NOTE ? askNewBankLine(s.words) : askFiredLine(s.words) };
  if (!had.reminded_at && now - Number(had.fired_asked_at) >= REMIND_AFTER_MS) return { ...ask, kind: "reminder", line: remindLine(s.words) };
  return null;
}

// ---------------------------------------------------------------- their answer
const textOf = (m) => typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.filter(b => b?.type === "text").map(b => String(b.text ?? "")).join("\n") : "";
const flat = (t) => String(t ?? "").toLowerCase().normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/[^\p{L}\p{N}']+/gu, " ").trim();
const YES_MORE = /^(yes|yeah|yep|yup|ok|okay|sure|go ahead|fine)\b[\s,.!]*((you can|that'?s fine|do that|every time|each time|all the time|always|please|for this one|sounds good)[\s,.!]*)*$/i;
const NO_MORE = /^(no|nope|nah|don'?t|do not|no thanks|no thank you)\b/i;
export const typedYes = (t) => isBareYes(t) || YES_MORE.test(String(t ?? "").trim());
export const typedNo = (t) => isBareRefusal(t) || NO_MORE.test(String(t ?? "").trim());

/**
 * Which open ask their newest message answers. Their newest own typed message (ownerTexts) is the
 * answer; what Reason said just before it (the run of its messages with nothing of theirs in between)
 * must END with the words of one open ask, the one shown last. That ask names its check-in, so the
 * row is the one whose words those are, never merely the newest row. → { row, typed, stale } | null
 */
function answeredAsk(c, messages) {
  const list = Array.isArray(messages) ? messages : [];
  // Their newest message in the thread (a tool's result inside this turn is not a message: not a string).
  let i = list.length - 1;
  while (i >= 0 && !(list[i]?.role === "user" && typeof list[i]?.content === "string")) i--;
  if (i < 0 || ownerTexts([list[i]]).length !== 1) return null;
  // Reason's own run of messages right before it: a message of theirs in between means this is not the answer.
  let j = i - 1;
  const said = [];
  while (j >= 0 && list[j]?.role === "assistant") { said.unshift(textOf(list[j])); j--; }
  if (!said.length) return null;
  // The model writes in its own lowercase voice: the ask is matched on its words, not its case or punctuation.
  const before = flat(said.join("\n"));
  const open = q("SELECT * FROM bank_checkin_grants WHERE conversation_id = ? AND state = 'asked' ORDER BY asked_at DESC").all(c)
    .filter(r => flat(r.words) && before.endsWith(flat(r.words)));
  if (!open.length) return null;
  const row = view(open[0]);
  return { row, typed: ownerTexts([list[i]])[0] ?? "", stale: !(Number(row.asked_at) >= clock.now() - ASK_TTL_MS) };
}

/**
 * bank checkin_answer: the grant, or the no, from their own typed reply on their own turn.
 * `standingWordsOf(key)` gives the check-in's own words for the periods.
 */
export function answer(c, { answer: said, kind, onCall = false, messages = [], standingWordsOf = () => "" }) {
  if (kind !== "user" || onCall) return { ok: false, error: "not_their_turn", say: "Only their own typed answer, in their own thread, can let a check-in read their bank. Nothing was changed. Say nothing about it now." };
  const got = answeredAsk(c, messages);
  if (!got) return { ok: false, error: "no_open_ask", say: "Nothing was changed: their last message is not an answer to the bank question. If they want a check-in to read their bank, it asks them itself." };
  const nowWords = String(standingWordsOf(got.row.standing) ?? "");
  // Too long after the ask, or the check-in's words changed since it was shown: asked again, fresh.
  if (got.stale || got.row.standing_words !== nowWords) {
    const line = askSetupLine(nowWords);
    noteAsked(c, got.row.standing, line, { kind: "setup", standingWords: nowWords });
    return { ok: false, error: "ask_expired", say_exactly: line, note: "Nothing was changed: that question was a while ago. Send say_exactly as it is, on its own, as your whole reply." };
  }
  if (said === "yes") {
    if (!typedYes(got.typed)) return { ok: false, error: "not_a_yes", say: "Nothing was changed: their message is not a plain yes. Ask once whether that check-in may read their bank each time it runs." };
    const g = decide(c, got.row.standing, "granted", { words: got.row.words, standingWords: nowWords, note: "their typed yes" });
    return { ok: true, granted: g.standing, say_exactly: SAID_YES, note: "Send say_exactly as it is." };
  }
  if (!typedNo(got.typed)) return { ok: false, error: "not_a_no", say: "Nothing was changed: their message is not a plain no. Ask once whether that check-in may read their bank each time it runs." };
  decide(c, got.row.standing, "declined", { words: got.row.words, standingWords: nowWords, note: "their typed no" });
  return { ok: true, declined: got.row.standing, say_exactly: SAID_NO, note: "Send say_exactly as it is. The check-in keeps running without their bank." };
}

// ---------------------------------------------------------------- a firing's read
const NOT_ASKED = { ok: false, error: "not_asked", say: "Their bank is only read when they ask, in their own message. Say nothing about their bank or money now." };
export const NOT_ASKED_RESULT = NOT_ASKED;
// The turns that read a bank under a grant: every tool after it that could carry it out is refused.
const readTurns = new WeakSet();
export const turnOf = (ctx) => (ctx?.turnActs && typeof ctx.turnActs === "object" ? ctx.turnActs : null);
export function markRead(ctx) { const t = turnOf(ctx); if (t) readTurns.add(t); }
export function readThisTurn(ctx) { const t = turnOf(ctx); return !!t && readTurns.has(t); }

/**
 * May this event turn read their bank? Only a timer's own firing (ctx.fromTimer, code's) of a standing
 * thing they granted, for an action and a period the grant covers. → { ok: true, input, grant } | refusal
 */
export function firingRead(c, ctx, input) {
  if (ctx?.onCall || ctx?.fromTimer == null || !Number.isInteger(Number(ctx.fromTimer))) return NOT_ASKED;
  const s = standingOf(c, Number(ctx.fromTimer));
  if (!s || !s.live) return NOT_ASKED;
  // Words changed since the answer, or a bank connected since the yes: no longer covered (asked again at the next firing).
  const g = current(c, s).row;
  if (!g) return NOT_ASKED;
  if (g.state === "asked") return { ...NOT_ASKED, note: "They were asked (by code) whether this check-in may read their bank and have not said yes. Do not ask again and do not mention it: do the rest of the check-in without it." };
  if (g.state === "declined") return { ok: false, error: "declined", say: "They said no to this check-in reading their bank. Do the rest of the check-in without it, and say nothing about their bank or money." };
  if (g.state !== "granted" || !g.actions.includes(input.action)) return { ok: false, error: "not_covered", say: `This check-in may only read ${g.actions.join(", ")}. Nothing else was read.` };
  if (input.action === "balance") return { ok: true, input: { action: "balance" }, grant: g };
  if (input.from || input.to) return { ok: false, error: "not_covered", say: `This check-in may only read ${g.periods.join(" or ")}, by period. Nothing was read.` };
  const period = input.period ?? g.periods[0];
  if (!g.periods.includes(period)) return { ok: false, error: "not_covered", say: `This check-in may only read ${g.periods.join(" or ")}. Nothing was read.` };
  return { ok: true, input: { ...input, period, search: input.search, category: input.category }, grant: g };
}

/** The one honest line for a granted firing whose read failed. */
export function failedLine(out) {
  let seen = "";
  try { seen = JSON.stringify(out ?? {}); } catch { seen = ""; }
  return /needs_reconnect|login_required|ITEM_LOGIN_REQUIRED|sign in again/i.test(seen) ? RECONNECT_LINE : FAILED_LINE;
}

// A granted firing whose read failed owes them the honest line: the runtime sends it itself if the
// turn said nothing (src/runtime.js _runTimer), so the quiet rule can never swallow it.
const owed = new Map();
export function oweLine(timerId, line) { if (timerId != null) owed.set(Number(timerId), String(line)); }
export function takeOwed(timerId) { const v = owed.get(Number(timerId)) ?? null; owed.delete(Number(timerId)); return v; }

/** Tests only. */
export function _reset() { owed.clear(); }
