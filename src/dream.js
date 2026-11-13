// The nightly memory review ("dreaming"), one person at a time.
//
// Everything else that writes memory reads a message as it lands: the in-turn `remember` tool, and
// the extractor (src/extract.js) over a window of four. Nothing ever went back. A fact saved off a
// misread line stayed wrong; two wordings of one thing both stayed; "I'm in Boston" stayed true a
// month after "we moved to Denver"; and a correction of how Reason BEHAVES ("stop sending me three
// options") was never kept anywhere a later turn would read it. So once a night, at a quiet hour in
// their own zone, for each person who has said anything since their last review:
//
//   1. one model pass reads that period's thread plus every active fact (with the messages each was
//      saved from, resolved to their words) and their "how to treat me" rules;
//   2. for each fact it says keep / correct (new wording) / merge into #id / retire, CITING the
//      message that justifies the change — code refuses any change without a citation it was shown;
//   3. it can add a rule from a behaviour correction in the transcript, and merge or retire rules a
//      later message contradicts; past db.RULES_CAP it must consolidate, and code enforces the cap.
//      A standing rule exists only because THEY said it: every rule the review writes (new or merged)
//      must cite their own message shown in the pass, a merge folds only rules a review wrote, and
//      the cap drops review-written rules before ever touching one they set themselves. Code checks
//      the citation, not the wording: nothing here judges that the rule says what they said.
//      Nothing they asked to forget is read: a forgotten line (recall_forgotten) is never in the
//      prompt, and a rule they took back is never re-learned off the message it came from.
//   4. every change goes through the existing status machinery (corrected / superseded /
//      superseded_by) — nothing is hard-deleted, and nothing they took back is ever written again;
//   5. the profile is rebuilt.
//
// COVERAGE (2026-11-12). Three ways somebody used to go unreviewed, each closed here:
//   - a first review only looked back a week, so somebody whose last message was older than that was
//     queued every night, found "nothing new", and was never read at all (9 of 16 accounts on live).
//     A first review with nothing in the last week now reads their newest messages instead;
//   - the window is three hours; a server that was down through it, or a CLI over its limit at 4am,
//     lost the night. Now any time after the window that same day the night is caught up — at most one
//     ask per person per CATCHUP_GAP_H, the time of each ask kept on disk (memory_reviews.attempted_at)
//     so a run of restarts cannot ask again and again, a few minutes after boot at the earliest, and
//     never more than MAX_PASSES_PER_DAY asks a day;
//   - one pass reads at most MAX_MESSAGES; somebody who says more than that a day never caught up
//     ("more": true every night). A pass that left a backlog is followed by another the same way.
//
// CALLS (REASON_REVIEW_CALLS). What they said on their own phone calls is in event_log too
// (src/calls/postcall.js, role call_user). With the switch on for them those lines are read and can
// be cited exactly like a text. Only a call that is theirs AND verified is their own word; a caller
// matched by caller ID alone, and the other side of a call Reason made for them (a business), are
// shown marked and can never be cited as something the person said. The same forget rule applies.
//
// PATTERNS (REASON_REVIEW_PATTERNS, `noticePatterns`). About once a week, after their review, one more
// pass reads only THEIR OWN lines from the last four weeks for things that recur. Each one kept must
// cite their own messages on two different days (code checks), is saved as a GUESS (db.NOTICED_SOURCE),
// never a fact, shows on their memory page with its receipts, is theirs to delete, and expires when
// nothing bears it out. Sensitive subjects are refused. Nobody who said no to patterns is ever read.
//
// WHERE IT RUNS. On the Claude subscription, through the claude CLI, on the background lane — the
// owner's explicit choice (2026-11-07). Never the billed API: on REASON_BACKEND=api, or when the CLI
// cannot be asked, the night is skipped quietly and the same messages are read the next night.
//
// PRIVACY. Logs carry counts and outcomes only, never a fact, a rule or a message. Every read is by
// this person's conversation id; one person's memory never reaches another's prompt.
import { withoutFinanceReplies } from "./plaid.js";
import { config, clock } from "./config.js";
import * as db from "./db.js";
import * as background from "./background.js";
import { askStructuredViaCli } from "./backends/cli.js";
import { onCli } from "./backends/side.js";
import { confirmedZone } from "./zone.js";
import { rebuildProfile, savedOn } from "./extract.js";
import { costOf } from "./spend.js";

/** A three-way switch (off | owner | on) for one conversation. */
function switchFor(value, conversationId) {
  if (value === "on") return true;
  if (value !== "owner" || !conversationId) return false;
  try { return !!db.getAccount(conversationId)?.is_operator; } catch { return false; }
}
/** Does their review read what they said on their own calls? */
export const reviewCallsFor = (conversationId) => switchFor(config.reviewCalls, conversationId);
/**
 * May things be noticed across days for them? The switch, and their own word: a no to patterns
 * (patterns_set off, "stop reading into my texts") always wins; under "on", somebody who is not the
 * operator must have said yes. Under "owner" the operator turning the switch on is the yes.
 */
export function patternsFor(conversationId) {
  if (!switchFor(config.reviewPatterns, conversationId)) return false;
  let said = null;
  try { said = db.noticePrefs(conversationId)?.patterns ?? null; } catch { return false; }
  if (said === "off") return false;
  if (said === "on") return true;
  try { return !!db.getAccount(conversationId)?.is_operator; } catch { return false; }
}

/** The hour (their clock) the review may start, and how long after it the night still counts. */
export const DREAM_HOUR = Number(process.env.REASON_DREAM_HOUR || 4);
const DREAM_WINDOW_H = 3;
/** Outside the window (a missed night, a backlog, a skipped ask): at most one ask per person this often. */
export const CATCHUP_GAP_MS = Number(process.env.REASON_DREAM_CATCHUP_GAP_H || 6) * 3600_000;
/** Inside the window, an ask that never finished (a restart mid-pass) is asked again no sooner than this. */
export const RETRY_GAP_MS = 30 * 60_000;
/** Asks of the model per person per day, whatever happens. */
export const MAX_PASSES_PER_DAY = 3;
/** A catch-up waits this long after boot: in a run of deploys the process is about to go away again. */
export const CATCHUP_SETTLE_MS = 3 * 60_000;
/** Catch-ups started per sweep, so a morning after an outage is spread over a few sweeps. */
const CATCHUP_PER_SWEEP = 2;
/** Where nobody has told us their zone. */
export const DEFAULT_ZONE = "America/New_York";

/** Input caps, per person per night. A backlog past them is read on the nights after. */
export const MAX_MESSAGES = 150;
export const MAX_TRANSCRIPT_CHARS = 30_000;
const MESSAGE_CHARS = 1_500;
export const MAX_FACTS = 150;
const FACT_CHARS = 300;
const SOURCE_CHARS = 240;
const SOURCES_PER_FACT = 2;
/** On someone's first review, only this far back: a year of history is not one night's read. */
const FIRST_LOOKBACK_MS = 7 * 24 * 3600_000;

/** Read on every pass, so a changed .env value takes effect at the next restart's first night. */
const MODEL = () => process.env.REASON_DREAM_CLI_MODEL || "opus";

/**
 * What one pass cost, per person: the model that answered, its tokens, and the API-equivalent $.
 * The $ is the CLI's own list-price figure (total_cost_usd) when it gave one, else priced off the
 * tokens (src/spend.js costOf). On the subscription nothing is billed; this is for comparing models.
 */
export function passCost(answer, asked) {
  const model = (answer?.models?.length ? answer.models.join(",") : "") || asked;
  const usage = answer?.usage ?? null;
  if (Number.isFinite(answer?.costUsd)) return { model, usage, costUsd: answer.costUsd, costFrom: "cli" };
  if (usage) {
    const usd = costOf(answer?.models?.[0] || asked, usage);
    return { model, usage, costUsd: usd || null, costFrom: usd ? "tokens" : "" };
  }
  return { model, usage, costUsd: null, costFrom: "" };
}
const tokenLog = ({ model, usage, costUsd, costFrom }) => ({
  model, input_tokens: usage?.input_tokens ?? null, output_tokens: usage?.output_tokens ?? null,
  cache_read_tokens: usage?.cache_read_input_tokens ?? null, cache_write_tokens: usage?.cache_creation_input_tokens ?? null,
  cost_usd: costUsd == null ? null : Math.round(costUsd * 1e6) / 1e6, cost_from: costFrom,
});
const TIMEOUT_MS = () => Number(process.env.REASON_DREAM_TIMEOUT_MS || 240_000);

const SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      description: "One entry per saved fact you change. A fact you leave out is kept as it is.",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", description: "The fact's # number." },
          action: { type: "string", enum: ["keep", "correct", "merge", "retire"] },
          wording: { type: "string", description: "correct only: the fact as it should now read, short, in their terms." },
          into: { type: "integer", description: "merge only: the # of the fact that already says the same thing (and says it best). Same subject only." },
          message: { type: "integer", description: "The m-number of the message that justifies the change. Required for correct, merge and retire." },
        },
        required: ["id", "action"],
      },
    },
    rules_new: {
      type: "array",
      description: "Corrections they made to how the assistant behaves, as standing rules. Only what they actually asked for.",
      items: {
        type: "object",
        properties: {
          rule: { type: "string", description: "The rule, short and in the imperative: 'Don't text before 9am on weekdays'." },
          why: { type: "string", description: "What it came from, in a few words: 'got a 7am text and said it was too early'." },
          message: { type: "integer", description: "The m-number of THEIR message the rule comes from." },
        },
        required: ["rule", "why", "message"],
      },
    },
    rules_merge: {
      type: "array",
      description: "Rules a review wrote (marked 'review') that say overlapping things, folded into one. Never rules they set themselves.",
      items: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "integer" }, description: "The R-numbers folded together (two or more)." },
          rule: { type: "string" },
          why: { type: "string" },
          message: { type: "integer", description: "The m-number of THEIR message behind the merged rule." },
        },
        required: ["ids", "rule", "why", "message"],
      },
    },
    rules_retire: {
      type: "array",
      description: "Rules a later message of theirs contradicts or takes back.",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, message: { type: "integer" } },
        required: ["id", "message"],
      },
    },
  },
  required: ["facts", "rules_new", "rules_merge", "rules_retire"],
};

const SYSTEM = `You are reviewing a personal assistant's memory of one person, overnight, against what they actually said.

You are shown the messages since the last review (numbered m123), the facts saved about them and the people in their life (numbered #45, each with the message it was saved from where that is known), and their "how to treat me" rules (numbered R7).

For each fact, decide:
- keep: still right. Leave it out of your answer entirely; anything not listed is kept.
- correct: it was saved wrong or is worded wrong, and a message shows the right version. Give the new wording.
- merge: it says the same thing as another fact about the same subject. Give "into" = the one that says it best.
- retire: a later message makes it no longer true (they moved, it finished, they changed their mind) and there is no new version to give.
Every change must cite, in "message", the m-number that justifies it. If no message shown to you justifies a change, keep the fact. Never correct a fact into something nobody said. When unsure, keep.

Rules are how they want the assistant to behave: timing, tone, what to show first, things to stop doing. Add one only when THEY corrected or asked for a change in how the assistant behaves; cite their message. A fact about them is not a rule. Retire a rule when a later message of theirs takes it back or contradicts it; merge overlapping rules marked "review" (never one they set themselves), citing their message. There may be at most {CAP} active rules: when there would be more, merge the overlapping review rules and keep what matters most.

Some lines may be marked as said on a phone call. What the person said on their own call counts exactly like a message of theirs, and you may cite it. A line marked "not the person" is a caller who was not verified, or the other side of a call the assistant made for them (a business, somebody else): it is never the person speaking. Never cite one to correct or retire a fact or to make or change a rule, and never treat what it says as something the person said or wants.

Answer only with the schema.`;

// ---------------------------------------------------------------- when

let testAsk = null;
/** For tests: what answers the review instead of the CLI. `(args) => { value } | { error }`. `null` puts the real one back. */
export function setDreamAsk(f) { testAsk = f; }

/** Their zone if one is known (confirmed, told, or read off their calendar), else New York. */
export function dreamZone(conversationId) {
  const z = confirmedZone(conversationId) || db.noticePrefs(conversationId)?.tz || db.noticeSweep(conversationId)?.time_zone || "";
  try { if (z) { new Intl.DateTimeFormat("en-US", { timeZone: z }); return z; } } catch {}
  return DEFAULT_ZONE;
}
const localHour = (at, tz) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(at))) % 24;
const localDay = (at, tz) => new Date(at).toLocaleDateString("en-CA", { timeZone: tz });

/** Is this the review's quiet hour where they are? */
export function inDreamHour(at, tz) {
  const h = localHour(at, tz);
  return h >= DREAM_HOUR && h < DREAM_HOUR + DREAM_WINDOW_H;
}

/** When today's window closed where they are (only asked after it has: no clock change falls between). */
function windowClosedAt(at, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", second: "numeric", hour12: false })
    .formatToParts(new Date(at)).map(x => [x.type, Number(x.value)]));
  return at - (((p.hour % 24) - (DREAM_HOUR + DREAM_WINDOW_H)) * 3600_000 + p.minute * 60_000 + p.second * 1000);
}

/** Why the review cannot ask a model right now, or null when it can. Never the API. */
export function whyNot() {
  if (!onCli()) return "not_on_cli";
  if (!testAsk && process.env.NODE_TEST_CONTEXT) return "test_runner";
  return null;
}

const reviewing = new Set();
let sweeping = false;

/**
 * The sweep's part (Runtime.dreams). Cheap: per person, a zone, an hour and one indexed query, and
 * a background-lane job only for somebody at their quiet hour, not yet reviewed tonight, with
 * something new said. Never throws, never waits on the model.
 */
export function sweepDreams({ now = clock.now(), log = () => {}, queue = background.enqueue, uptimeMs = process.uptime() * 1000 } = {}) {
  const out = { queued: 0, caught_up: 0 };
  const why = whyNot();
  if (why) return { ...out, skipped: why };
  if (sweeping) return { ...out, skipped: "already_sweeping" };
  sweeping = true;
  try {
    for (const acct of db.listAccountsOfPeople()) {
      if ((acct.state ?? "active") !== "active" || (!acct.is_operator && db.stoppedStateOf(acct.address))) continue;
      const c = acct.conversation_id;
      if (reviewing.has(c)) continue;
      const tz = dreamZone(c);
      // Not before tonight's hour has come: the day that is due is their own, from DREAM_HOUR on.
      if (localHour(now, tz) < DREAM_HOUR) continue;
      const day = localDay(now, tz);
      const state = db.memoryReviewState(c);
      const doneToday = state.last_day === day;
      // Today's pass ran and finished: nothing more, unless it left a backlog or could not ask.
      const unfinished = doneToday && (state.last_outcome === "reviewed_more" || String(state.last_outcome).startsWith("skipped:"));
      if (doneToday && !unfinished) continue;
      const sinceAsk = now - (Number(state.attempted_at) || 0);
      const late = !inDreamHour(now, tz) || unfinished;
      if (late) {
        // The catch-up: a missed window, a backlog, an ask that was skipped. Rate-limited on disk.
        if (sinceAsk < CATCHUP_GAP_MS || uptimeMs < CATCHUP_SETTLE_MS || out.caught_up >= CATCHUP_PER_SWEEP) continue;
      } else if (sinceAsk < RETRY_GAP_MS) continue;
      if (db.memoryReviewPassesOn(c, day) >= MAX_PASSES_PER_DAY) continue;
      // A night is only "missed" if there was something to read when its window closed. Somebody who
      // had said nothing by then and texts at noon is read tonight, as always: not one more pass, in
      // the middle of their day, for every person every day.
      const before = late && !unfinished ? windowClosedAt(now, tz) : null;
      if (!db.hasEventsSince(c, state.last_event_id, { calls: reviewCallsFor(c), before })) continue;
      // Written before the model is asked: a restart mid-pass finds it and waits its turn.
      try { db.noteMemoryReviewAttempt(c, now); } catch { continue; }
      reviewing.add(c);
      out.queued++;
      if (late) out.caught_up++;
      Promise.resolve(queue(`dream:${c}`, () => reviewOne(c, { now: clock.now(), day, log, when: late ? "catch_up" : "window" })))
        .catch(e => log({ memory_review: "failed", conversation: c, error_kind: errorKind(e) }))
        .finally(() => reviewing.delete(c));
    }
  } finally {
    sweeping = false;
  }
  return out;
}

/**
 * The boot line: the review is armed (or why not), the model it will ask, its hour, and when the
 * next window opens in the default zone. People with a known zone get theirs. Counts only.
 */
export function armedLine({ now = clock.now() } = {}) {
  let next = null;
  for (let t = Math.ceil(now / 60_000) * 60_000, end = now + 26 * 3600_000; t < end; t += 60_000) {
    if (localHour(t, DEFAULT_ZONE) === DREAM_HOUR && new Date(t).getUTCMinutes() === 0) { next = new Date(t).toISOString(); break; }
  }
  return { memory_review: "armed", model: MODEL(), hour: DREAM_HOUR, window_h: DREAM_WINDOW_H, default_zone: DEFAULT_ZONE, next_default_window: next, off: whyNot() };
}

/** For tests. */
export function resetDreams() { reviewing.clear(); sweeping = false; testAsk = null; }

/** What kind of failure, as a word: an error's text can quote what it was reading. */
const errorKind = (e) => {
  const m = String(e?.message ?? e ?? "");
  if (/could not run|ENOENT|not found/i.test(m)) return "cli_missing";
  if (/limit|login|oauth|credential|authenticat|expired/i.test(m)) return "cli_unavailable";
  if (/did not finish|timed? ?out/i.test(m)) return "timeout";
  if (/JSON|schema/i.test(m)) return "bad_answer";
  return "error";
};

// ---------------------------------------------------------------- what it reads

const cut = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const parseIds = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []; } catch { return []; } };

/**
 * A call line's place in the review. The person's own words on their own verified call are a
 * message of theirs ("user"); the assistant's side is the assistant. Anything else on a call — a
 * caller known by caller ID alone, or the other side of a call Reason made for them — is shown,
 * marked, under a role no citation check accepts as the person's own.
 */
function callLine(r) {
  const own = Number(r.call_owner) === 1;
  const verified = own && (!!r.call_verified_at || String(r.call_direction ?? "out") !== "in");
  if (r.role === "call_assistant") return { role: "assistant", where: own ? "on a phone call with them" : "on a call it made for them" };
  if (verified) return { role: "user", where: "on a phone call" };
  if (own) return { role: "caller", where: "on a phone call, caller not verified — not the person" };
  return { role: "other", where: "the other side of a call made for them — not the person" };
}

/**
 * The period's messages, capped: oldest first, up to the caps. `lastId` is the last one read.
 * `calls`: their phone calls' lines are part of the period (REASON_REVIEW_CALLS).
 */
export function periodMessages(conversationId, afterId, { now = clock.now(), calls = reviewCallsFor(conversationId) } = {}) {
  const roles = calls ? "('user', 'assistant', 'call_user', 'call_assistant')" : "('user', 'assistant')";
  let from = Number(afterId) || 0;
  if (!from) {
    const before = db.db.prepare("SELECT MAX(id) AS id FROM event_log WHERE conversation_id = ? AND at < ?").get(conversationId, now - FIRST_LOOKBACK_MS)?.id;
    from = before ?? 0;
    // Never reviewed, and nothing of theirs inside the lookback: somebody who went quiet more than a
    // week before their first review was never read at all. Their newest messages instead.
    if (from && !db.hasEventsSince(conversationId, from, { calls })) {
      from = db.db.prepare(`SELECT id FROM event_log WHERE conversation_id = ? AND role IN ${roles} ORDER BY id DESC LIMIT 1 OFFSET ?`)
        .get(conversationId, MAX_MESSAGES)?.id ?? 0;
    }
  }
  // Never a line they asked Reason to forget (src/db.js forgetFromRecall): those are out of every read.
  const rows = db.db.prepare(`SELECT e.id, e.role, e.content, e.at, k.is_owner AS call_owner, k.direction AS call_direction, k.verified_at AS call_verified_at
    FROM event_log e LEFT JOIN calls k ON e.channel = 'call' AND k.id = CAST(e.message_id AS INTEGER) AND k.conversation_id = e.conversation_id
    WHERE e.conversation_id = ? AND e.id > ? AND e.role IN ${roles}
    AND ${db.eventNotForgotten("e")} ORDER BY e.id LIMIT ?`).all(conversationId, from, MAX_MESSAGES + 1);
  const picked = [];
  let chars = 0;
  // Reason's replies that answered from their bank are not read (src/plaid.js); their own words are.
  const readable = new Set(withoutFinanceReplies(conversationId, rows).map(r => r.id));
  for (const r of rows.slice(0, MAX_MESSAGES)) {
    if (!readable.has(r.id)) continue;
    const text = cut(r.content, MESSAGE_CHARS);
    if (!text) continue;
    if (picked.length && chars + text.length > MAX_TRANSCRIPT_CHARS) break;
    chars += text.length;
    const line = r.role === "call_user" || r.role === "call_assistant" ? callLine(r) : { role: r.role, where: "" };
    picked.push({ id: r.id, content: r.content, at: r.at, text, ...line });
  }
  const lastId = picked.length ? picked[picked.length - 1].id : null;
  return { messages: picked, lastId, more: rows.length > picked.length };
}

/** The prompt, and every number it showed (so a citation or an id can be checked). */
export function reviewPrompt(conversationId, { messages, facts, rules, now = clock.now() }) {
  const shownMessages = new Map(messages.map(m => [m.id, m]));
  const sources = db.eventsByIds(conversationId, facts.flatMap(f => parseIds(f.source_message_ids).slice(-SOURCES_PER_FACT)));
  // A fact's source that is a call line keeps its raw role (call_user / call_assistant): shown, and
  // never accepted as the person's own message by a citation check.
  for (const s of sources) if (!shownMessages.has(s.id)) shownMessages.set(s.id, { ...s, text: cut(s.content, SOURCE_CHARS) });
  const name = db.getAccount(conversationId)?.name || "them";
  const factLines = facts.map(f => {
    const from = parseIds(f.source_message_ids).slice(-SOURCES_PER_FACT).filter(id => shownMessages.has(id));
    const quoted = from.map(id => `\n   from m${id} (${shownMessages.get(id).role}): "${cut(shownMessages.get(id).text ?? shownMessages.get(id).content, SOURCE_CHARS)}"`).join("");
    return `#${f.id} [${f.about}] (saved ${savedOn(f.created_at)}${f.source === "inferred" ? ", inferred" : ", they said it"}) ${cut(f.fact, FACT_CHARS)}${quoted}`;
  });
  const ruleLines = rules.map(r => `R${r.id} (saved ${savedOn(r.created_at)}${r.source === "they_said" ? ", they set it" : ", review"}${r.source_message_id ? `, from m${r.source_message_id}` : ""}) ${cut(r.rule, 300)}${r.why ? ` — why: ${cut(r.why, 200)}` : ""}`);
  const prompt = `Today is ${savedOn(now)}. The person is ${name}.\n\n`
    + `Messages since the last review, oldest first:\n${messages.map(m => `[m${m.id}] (${m.role}${m.where ? `, ${m.where}` : ""}, ${savedOn(m.at)}): ${m.text}`).join("\n") || "(none)"}\n\n`
    + `Saved facts:\n${factLines.join("\n") || "(none)"}\n\n`
    + `How-to-treat-me rules (${rules.length} of at most ${db.RULES_CAP}):\n${ruleLines.join("\n") || "(none)"}`;
  return { prompt, shownMessages, shownFacts: new Map(facts.map(f => [f.id, f])), shownRules: new Map(rules.map(r => [r.id, r])) };
}

// ---------------------------------------------------------------- one night, one person

/**
 * Review one person's memory. Returns counts only. `ask` defaults to the CLI (never the API);
 * `rebuild` to the profile rebuild.
 */
export async function reviewOne(conversationId, { now = clock.now(), day = localDay(now, dreamZone(conversationId)), log = () => {}, ask = null, rebuild = null, when = "" } = {}) {
  const c = conversationId;
  const counts = { kept: 0, corrected: 0, merged: 0, retired: 0, refused: 0, rules_added: 0, rules_merged: 0, rules_retired: 0, rules_capped: 0 };
  const why = ask ? null : whyNot();
  if (why) { log({ memory_review: "skipped", why }); return { skipped: why }; }
  const state = db.memoryReviewState(c);
  const { messages, lastId, more } = periodMessages(c, state.last_event_id, { now });
  if (!messages.length) {
    db.markMemoryReview(c, { day, outcome: "nothing_new", at: now });
    return { skipped: "nothing_new" };
  }
  const facts = db.activeFacts(c, { limit: MAX_FACTS });
  const rules = db.activeRules(c);
  const shown = reviewPrompt(c, { messages, facts, rules, now });

  const model = MODEL();
  const answer = await (ask ?? testAsk ?? askStructuredViaCli)({
    prompt: shown.prompt, system: SYSTEM.replace("{CAP}", String(db.RULES_CAP)), schema: SCHEMA,
    model, timeoutMs: TIMEOUT_MS(), feature: "memory_review",
  });
  const cost = passCost(answer, model);
  const sizes = { messages: messages.length, facts: facts.length, rules: rules.length };
  const record = (outcome, n = {}) => {
    try { db.recordMemoryReviewPass(c, { day, at: now, outcome, ...cost, counts: { ...sizes, ...n } }); } catch { /* a counter never costs a review */ }
  };
  if (!answer?.value) {
    // The CLI is signed out, limited, missing, or answered off the schema. Quietly skipped; the
    // watermark does not move, so the same messages are read the next night.
    const kind = answer?.refusal ? "refused" : errorKind(answer?.error);
    db.markMemoryReview(c, { day, outcome: `skipped:${kind}`, at: now });
    record(`skipped:${kind}`);
    log({ memory_review: "skipped", conversation: c, why: kind, ...tokenLog(cost) });
    return { skipped: kind };
  }

  const v = answer.value;
  const userMsg = (id) => { const m = shown.shownMessages.get(Number(id)); return m && m.role === "user" ? m : null; };
  const anyMsg = (id) => shown.shownMessages.get(Number(id)) ?? null;
  const touched = new Set();
  const targets = new Set();
  const changes = Array.isArray(v.facts) ? v.facts.filter(x => x && Number.isInteger(Number(x.id))) : [];
  const order = { merge: 0, correct: 1, retire: 2, keep: 3 };
  changes.sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9));
  const oldWords = [];

  for (const ch of changes) {
    const id = Number(ch.id);
    const fact = shown.shownFacts.get(id);
    if (!fact || touched.has(id)) { counts.refused++; continue; }
    if (ch.action === "keep") { counts.kept++; continue; }
    if (ch.action === "merge") {
      const into = Number(ch.into);
      if (!shown.shownFacts.has(into) || touched.has(into) || !anyMsg(ch.message)) { counts.refused++; continue; }
      const r = db.retireForNewer(c, id, into);
      if (!r.ok) { counts.refused++; continue; }
      touched.add(id); targets.add(into); counts.merged++;
      continue;
    }
    if (ch.action === "correct") {
      const cited = userMsg(ch.message);
      const wording = cut(ch.wording, FACT_CHARS);
      if (!cited || !wording) { counts.refused++; continue; }
      if (db.factTakenBack(c, fact.person_id, wording)) { counts.refused++; continue; }
      const r = db.correctFact(c, id, { fact: wording });
      if (!r.ok || r.unchanged) { counts.refused++; continue; }
      db.setFactSources(c, r.newId, [cited.id]);
      oldWords.push(fact.fact);
      touched.add(id); counts.corrected++;
      import("./embedding.js").then(m => { m.removeEmbedding(id); return m.embedAndStore(c, r.newId, `${fact.about}: ${wording}`); }).catch(() => {});
      continue;
    }
    if (ch.action === "retire") {
      if (!userMsg(ch.message) || targets.has(id)) { counts.refused++; continue; }
      const r = db.retireFact(c, id, { at: now });
      if (!r.ok) { counts.refused++; continue; }
      touched.add(id); counts.retired++;
      continue;
    }
    counts.refused++;
  }
  // A corrected wording out of the memory tools' saved results, so the next turn does not read it
  // back from an old recall (as memory_fix does).
  if (oldWords.length) { try { db.scrubToolResults(c, { tools: db.MEMORY_TOOL_NAMES, mentioning: oldWords }); } catch {} }

  // Rules: retire, merge, add — then the cap.
  const ruleGone = new Set();
  for (const x of Array.isArray(v.rules_retire) ? v.rules_retire : []) {
    const id = Number(x?.id);
    if (!shown.shownRules.has(id) || ruleGone.has(id) || !userMsg(x.message)) { counts.refused++; continue; }
    if (db.supersedeRule(c, id, { at: now }).ok) { ruleGone.add(id); counts.rules_retired++; } else counts.refused++;
  }
  for (const x of Array.isArray(v.rules_merge) ? v.rules_merge : []) {
    const ids = [...new Set((x?.ids ?? []).map(Number))].filter(id => shown.shownRules.has(id) && !ruleGone.has(id));
    // Their own message, shown this pass, behind the merged wording; and only review-written rules
    // fold: one they set themselves is never replaced by model text.
    const cited = userMsg(x?.message);
    if (ids.length < 2 || !cited || db.ruleTakenBackFrom(c, cited.id) || !String(x.rule ?? "").trim()
      || ids.some(id => shown.shownRules.get(id).source === "they_said")) { counts.refused++; continue; }
    const from = cited.id;
    // The rules were read before the model was asked, minutes ago: a rule they forgot or reworded in
    // the meantime (/web/memory, memory_drop) is not this review's to fold. Every one must still be
    // active now, or the whole merge is refused — its wording may carry the one they took back.
    if (ids.some(id => !db.getRule(c, id))) { counts.refused++; continue; }
    // Folded first, so the merged rule never counts against the ceiling it is making room under.
    // Only what this pass itself superseded is ever put back.
    const folded = ids.filter(id => db.supersedeRule(c, id, { at: now }).ok);
    const putBack = () => { for (const id of folded) db.db.prepare(`UPDATE treat_rules SET status = 'active', superseded_by = NULL, retired_at = NULL
      WHERE id = ? AND conversation_id = ? AND status = 'superseded' AND superseded_by IS NULL AND retired_at = ?`).run(id, c, now); };
    if (folded.length !== ids.length) { putBack(); counts.refused++; continue; }
    const made = db.addRule(c, { rule: x.rule, why: x.why, sourceMessageId: from, source: "review", at: now });
    if (!made.ok) {
      // Put them back rather than lose them: a merge that could not be written is no merge.
      putBack();
      counts.refused++;
      continue;
    }
    for (const id of ids) { db.db.prepare("UPDATE treat_rules SET superseded_by = ? WHERE id = ? AND conversation_id = ? AND status = 'superseded' AND superseded_by IS NULL").run(made.rule.id, id, c); ruleGone.add(id); }
    counts.rules_merged += ids.length;
  }
  for (const x of Array.isArray(v.rules_new) ? v.rules_new : []) {
    const cited = userMsg(x?.message);
    // Not off a message a rule they took back came from: deleted means deleted, however it is reworded.
    if (!cited || db.ruleTakenBackFrom(c, cited.id) || !String(x.rule ?? "").trim()) { counts.refused++; continue; }
    const made = db.addRule(c, { rule: x.rule, why: x.why, sourceMessageId: cited.id, source: "review", at: now });
    if (made.ok && !made.already) counts.rules_added++;
    else if (!made.ok) counts.refused++;
  }
  // The hard cap. The model was told to consolidate; whatever is still over goes oldest first —
  // review-written rules before any they set themselves, so a review never makes room for its own.
  const live = db.activeRules(c, { limit: 100 });
  const over = live.length - db.RULES_CAP;
  if (over > 0) {
    const oldestFirst = [...live].reverse();
    const drop = [...oldestFirst.filter(r => r.source !== "they_said"), ...oldestFirst.filter(r => r.source === "they_said")].slice(0, over);
    for (const r of drop) if (db.supersedeRule(c, r.id, { at: now }).ok) counts.rules_capped++;
  }

  // "reviewed_more": read, with a backlog left past the caps — the sweep comes back for it today.
  db.markMemoryReview(c, { day, lastEventId: lastId, outcome: more ? "reviewed_more" : "reviewed", at: now });
  const changed = counts.corrected + counts.merged + counts.retired;
  if (changed || !db.getProfile(c)) {
    try { await (rebuild ?? ((id) => rebuildProfile(id, { log })))(c); } catch (e) { log({ memory_review: "profile_failed", conversation: c, error_kind: errorKind(e) }); }
  }
  record("reviewed", counts);
  log({ memory_review: "done", conversation: c, ...(when ? { when } : {}), ...sizes, more, ...counts, ...tokenLog(cost) });
  // Things that recur across days: its own pass, about once a week, never allowed to cost the review.
  let patterns = null;
  if (!more) {
    try { patterns = await noticePatterns(c, { now, log, ask }); }
    catch (e) { log({ memory_patterns: "failed", conversation: c, error_kind: errorKind(e) }); }
  }
  return { ok: true, messages: messages.length, more, ...counts, model: cost.model, cost_usd: cost.costUsd, ...(patterns ? { patterns } : {}) };
}

// ---------------------------------------------------------------- patterns across days

/** How far back the patterns pass reads, and how often it runs per person. */
export const PATTERN_DAYS = 28;
export const PATTERN_EVERY_MS = 7 * 24 * 3600_000;
/** A failed ask is tried again the next night, not the next week. */
const PATTERN_RETRY_MS = 20 * 3600_000;
const PATTERN_MESSAGES = 400;
const PATTERN_CHARS = 40_000;
const PATTERN_LINE = 300;
/** Kept per person, and added per pass. */
export const PATTERNS_KEPT = 8;
const PATTERNS_PER_PASS = 3;
/** The only kinds kept. Anything else — and anything the reader marks sensitive — is refused by code. */
export const PATTERN_KINDS = ["repeated_ask", "routine", "assistant_mistake", "preference"];

const PATTERN_SCHEMA = {
  type: "object",
  properties: {
    patterns: {
      type: "array",
      description: "Things that recur in what they said, each on at least two DIFFERENT days. Few and certain; an empty list is a good answer.",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: PATTERN_KINDS, description: "repeated_ask: they ask for the same kind of thing again and again. routine: something they do on a regular beat. assistant_mistake: the same mistake by the assistant that they had to point out more than once. preference: a like, dislike or way of doing things they showed more than once." },
          pattern: { type: "string", description: "What you noticed, short, as a thing you THINK, in plain words: 'asks for the weather before leaving for work'." },
          use: { type: "string", description: "What the assistant should do differently because of it, in a few words." },
          messages: { type: "array", items: { type: "integer" }, description: "The m-numbers of THEIR messages it rests on: at least two, from at least two different days." },
          sensitive: { type: "boolean", description: "true if this touches health or mental health, sex or sexuality, religion, politics, race or ethnicity, immigration status, money trouble or debt, crime or legal trouble, or addiction." },
        },
        required: ["kind", "pattern", "use", "messages", "sensitive"],
      },
    },
    still: {
      type: "array",
      description: "Things already noticed (numbered N) that their messages shown here bear out again.",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, messages: { type: "array", items: { type: "integer" } } },
        required: ["id", "messages"],
      },
    },
  },
  required: ["patterns", "still"],
};

const PATTERN_SYSTEM = `You are reading several weeks of what one person said to their personal assistant, looking for things that RECUR across days.

You are shown only their own messages (numbered m123, with the day each was said) and the things already noticed about them (numbered N4).

Look for four kinds only: an ask they repeat, a routine, a mistake of the assistant's they had to point out more than once, a preference they showed more than once. Each must rest on their own messages from at least two DIFFERENT days; cite them. One day is something that happened, not a pattern. Do not restate something already noticed: list it under "still" with the messages that bear it out again.

Never notice anything about health or mental health, sex or sexuality, religion, politics, race or ethnicity, immigration status, money trouble or debt, crime or legal trouble, or addiction — if the only patterns you see are of that kind, return none. Mark "sensitive" honestly; code drops those.

These are guesses, not facts: word each as something you think, and prefer none to a weak one. Answer only with the schema.`;

/** Their own lines of the last PATTERN_DAYS, oldest first, newest kept when over the caps. Never a forgotten line. */
export function patternMessages(conversationId, { now = clock.now(), calls = reviewCallsFor(conversationId) } = {}) {
  const said = calls
    ? `(e.role = 'user' OR (e.role = 'call_user' AND e.channel = 'call' AND EXISTS (SELECT 1 FROM calls k WHERE k.id = CAST(e.message_id AS INTEGER)
        AND k.conversation_id = e.conversation_id AND k.is_owner = 1 AND (k.verified_at IS NOT NULL OR COALESCE(k.direction, 'out') != 'in'))))`
    : "e.role = 'user'";
  const rows = db.db.prepare(`SELECT e.id, e.content, e.at FROM event_log e WHERE e.conversation_id = ? AND e.at >= ? AND ${said}
    AND ${db.eventNotForgotten("e")} ORDER BY e.id DESC LIMIT ?`).all(conversationId, now - PATTERN_DAYS * 24 * 3600_000, PATTERN_MESSAGES);
  const picked = [];
  let chars = 0;
  for (const r of rows) {
    const text = cut(r.content, PATTERN_LINE);
    if (!text) continue;
    if (chars + text.length > PATTERN_CHARS) break;
    chars += text.length;
    picked.push({ id: r.id, at: r.at, text });
  }
  return picked.reverse();
}

/**
 * The patterns pass for one person. Returns counts only, or `{ skipped }`. Same lane as the review
 * (the CLI on the subscription, never the API). Everything it keeps is a guess (db.NOTICED_SOURCE).
 */
export async function noticePatterns(conversationId, { now = clock.now(), log = () => {}, ask = null, force = false } = {}) {
  const c = conversationId;
  if (!patternsFor(c)) return { skipped: "off" };
  const why = ask ? null : whyNot();
  if (why) return { skipped: why };
  const last = Number(db.memoryReviewState(c).patterns_at) || 0;
  if (!force && last && now - last < PATTERN_EVERY_MS) return { skipped: "not_due" };

  // Whatever was noticed and nothing has borne out since is dropped: a pattern is a claim about now.
  let expired = 0;
  for (const row of db.listNoticed(c, { limit: 100 })) {
    if ((row.last_supported_at ?? row.noted_at) < now - PATTERN_DAYS * 24 * 3600_000) { if (db.dropGuess(c, row.id).ok) expired++; }
  }

  const tz = dreamZone(c);
  const messages = patternMessages(c, { now });
  const dayOf = new Map(messages.map(m => [m.id, localDay(m.at, tz)]));
  if (new Set(dayOf.values()).size < 2) {
    db.markPatternPass(c, now);
    if (expired) log({ memory_patterns: "done", conversation: c, messages: messages.length, noticed: 0, supported: 0, refused: 0, expired });
    return { skipped: "too_little", expired };
  }
  const had = db.listNoticed(c, { limit: PATTERNS_KEPT * 2 });
  const name = db.getAccount(c)?.name || "them";
  const prompt = `Today is ${savedOn(now)}. The person is ${name}.\n\n`
    + `Their own messages over the last ${PATTERN_DAYS} days, oldest first:\n${messages.map(m => `[m${m.id}] (${dayOf.get(m.id)}): ${m.text}`).join("\n")}\n\n`
    + `Already noticed:\n${had.map(g => `N${g.id} ${cut(g.guess, 200)}`).join("\n") || "(nothing)"}`;

  // Marked before the ask, so a restart in the middle does not ask again tonight.
  db.markPatternPass(c, now);
  const model = MODEL();
  let answer;
  try {
    answer = await (ask ?? testAsk ?? askStructuredViaCli)({
      prompt, system: PATTERN_SYSTEM, schema: PATTERN_SCHEMA, model, timeoutMs: TIMEOUT_MS(), feature: "memory_patterns",
    });
  } catch (e) { answer = { error: e }; }
  const cost = passCost(answer, model);
  // A pattern pass answers on its own schema; a review answer handed to it by mistake is not one.
  if (!answer?.value || !Array.isArray(answer.value.patterns)) {
    const kind = answer?.value ? "bad_answer" : answer?.refusal ? "refused" : errorKind(answer?.error);
    db.markPatternPass(c, now - PATTERN_EVERY_MS + PATTERN_RETRY_MS);
    log({ memory_patterns: "skipped", conversation: c, why: kind, ...tokenLog(cost) });
    return { skipped: kind, expired };
  }

  const counts = { noticed: 0, supported: 0, refused: 0, expired };
  const shown = new Map(messages.map(m => [m.id, m]));
  /** Their own messages among the cited ones, as receipts — and on how many different days. */
  const receipts = (ids) => {
    const own = [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter(id => shown.has(id)).sort((a, b) => a - b);
    return { own, days: new Set(own.map(id => dayOf.get(id))).size, evidence: own.map(id => ({ ref: `m${id}`, at: shown.get(id).at, day: dayOf.get(id) })) };
  };
  const mine = new Map(had.map(g => [g.id, g]));
  for (const x of Array.isArray(answer.value.still) ? answer.value.still : []) {
    const r = receipts(x?.messages);
    if (!mine.has(Number(x?.id)) || !r.own.length) { counts.refused++; continue; }
    if (db.supportNoticed(c, Number(x.id), now, { evidence: r.evidence })) counts.supported++; else counts.refused++;
  }
  let active = db.listNoticed(c, { limit: 100 }).length;
  for (const x of answer.value.patterns) {
    const text = cut(x?.pattern, 240);
    const r = receipts(x?.messages);
    // Code's bar: a known kind, not sensitive, their own messages on two different days, room left.
    if (!text || !PATTERN_KINDS.includes(x?.kind) || x?.sensitive !== false || r.own.length < 2 || r.days < 2
      || counts.noticed >= PATTERNS_PER_PASS) { counts.refused++; continue; }
    const before = db.db.prepare("SELECT * FROM guesses WHERE conversation_id = ? AND pt(about) = ? AND pt(guess) = ?").get(c, name, text);
    if (before) {
      // The same words again. One they dismissed or confirmed is never noticed a second time.
      if (before.how === db.NOTICED_SOURCE && db.supportNoticed(c, before.id, now, { evidence: r.evidence })) counts.supported++; else counts.refused++;
      continue;
    }
    if (active >= PATTERNS_KEPT) { counts.refused++; continue; }
    const made = db.noteGuess(c, { about: name, guess: text, how: db.NOTICED_SOURCE, evidence: r.evidence, use: cut(x?.use, 200) });
    if (made && !made.already_guessed) { counts.noticed++; active++; } else counts.refused++;
  }
  log({ memory_patterns: "done", conversation: c, messages: messages.length, days: new Set(dayOf.values()).size, ...counts, ...tokenLog(cost) });
  return { ok: true, ...counts };
}
