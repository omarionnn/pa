// What Reason has already told them and asked them, so a later message cannot quietly contradict
// the first or re-ask a question that is closed.
//
// The incident (2026-10-24): one reply said Alamo's earliest Tuesday showing was 11:15am, "a maybe,
// not confirmed", and asked "want me to open Alamo's site and get exact times?". The next reply,
// a minute later, said 11:00am straight from the site — with no word that the first was wrong — and
// the question was left hanging, so a late "yes" would have sent Reason back to do it again.
//
// Two small per-conversation records (src/db.js):
//   sent_claims      the concrete values a sent message asserted (a showtime, a price, which place is
//                    closest), confirmed or a maybe. A later message that changes one supersedes it,
//                    and whether it SAID so is written down (flagged).
//   open_questions   every question Reason asked; closed when they answer it, when Reason's own later
//                    work answers it, or when it is obsolete.
//
// Three uses:
//   record()       after a reply has gone: one small side call reads what it asserted and asked,
//                  against what was standing, and writes both records. Off the reply's path.
//   standingNote() the block each turn is shown: what is standing, what is open, what just closed —
//                  so the model corrects out loud and never re-asks.
//   checkDraft()   right before a reply goes: does it change a standing value without saying so, or
//                  ask a closed question? API only and only when there is something standing,
//                  because it sits in front of the send. The runtime recomposes once on a hit.
//
// Every read and write is scoped by conversation_id. Nothing here ever throws into a turn.
import * as db from "./db.js";
import { askJson } from "./onethought.js";
import { config, clock } from "./config.js";

const HOUR = 3_600_000;
/** How far back a claim or question counts as part of the conversation now. */
export const WINDOW_MS = 24 * HOUR;
/** The send-time check only looks at what was said in the last few hours: that is the live thread. */
export const CHECK_WINDOW_MS = 6 * HOUR;

const one = (s, n = 140) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const claimLine = (c) => `  claim #${c.id}: ${one(c.subject, 80)} = ${one(c.value, 80)}${c.certain ? "" : " (a maybe, not confirmed)"}`;
const questionLine = (q) => `  question #${q.id}: "${one(q.question)}"`;

/** The block for a turn, or "" when nothing is standing or open. */
export function standingNote(conversationId, { now = clock.now() } = {}) {
  try {
    const since = now - WINDOW_MS;
    const claims = db.standingClaims(conversationId, { since, limit: 8 });
    const open = db.openQuestions(conversationId, { since, limit: 6 });
    const closed = db.closedQuestions(conversationId, { since: now - CHECK_WINDOW_MS, limit: 4 });
    if (!claims.length && !open.length && !closed.length) return "";
    const parts = [];
    if (claims.length) parts.push(`What you have already told them that still stands (from your sent messages). If your answer changes any of these, say so in the same message — "earlier I said X, it's Y" — never leave two values standing:\n${claims.map(claimLine).join("\n")}`);
    if (open.length) parts.push(`Questions you asked them that are still open. Do not ask them again; if the new message or your own work answers one, act on it:\n${open.map(questionLine).join("\n")}`);
    if (closed.length) parts.push(`Questions you asked that are CLOSED. A late "yes" to one of these does not restart the work — say what you already found:\n${closed.map(q => `${questionLine(q)} — ${String(q.closed_reason ?? "closed").replace(/_/g, " ")}`).join("\n")}`);
    return parts.join("\n");
  } catch {
    return "";
  }
}

// ---------- after a reply has gone ----------

export const RECORD_INSTRUCTIONS = `You keep a ledger for a personal assistant that texts one person. You are shown what the person just said, the assistant's message that was just sent to them, and what the ledger already holds. Fill in:
- claims: concrete values the sent message asserts that the person may rely on — a time, a date, a price, an address, which place is closest and to what, a count. Subject says what it is about precisely ("earliest Tuesday showing at Alamo Lower Manhattan"); value is the value ("11:00am"). certain is false when the message hedges it (a maybe, a guess, not confirmed). At most 5. Skip pleasantries and anything not concrete.
- supersedes: ledger claims whose value this message changes or withdraws. flagged is true only if the message says out loud that the earlier value changed or was wrong.
- questions: questions the sent message asks the person, word for word or nearly. Skip rhetorical ones.
- closes: open ledger questions that are now settled — answered_by_them if the person's text answers it, answered_by_reason if the assistant's message did the thing or gave the answer itself, obsolete if it no longer applies.`;

const RECORD_SCHEMA = {
  type: "object",
  properties: {
    claims: { type: "array", items: { type: "object", properties: { subject: { type: "string" }, value: { type: "string" }, certain: { type: "boolean" } }, required: ["subject", "value", "certain"], additionalProperties: false } },
    supersedes: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, flagged: { type: "boolean" } }, required: ["id", "flagged"], additionalProperties: false } },
    questions: { type: "array", items: { type: "string" } },
    closes: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, why: { type: "string", enum: ["answered_by_them", "answered_by_reason", "obsolete"] } }, required: ["id", "why"], additionalProperties: false } },
  },
  required: ["claims", "supersedes", "questions", "closes"],
  additionalProperties: false,
};

export function recordPrompt({ userText, reply, claims, open }) {
  return `The person just said:\n${String(userText ?? "").slice(0, 1_500)}\n\n`
    + `The assistant's message that was just sent:\n${String(reply ?? "").slice(0, 3_000)}\n\n`
    + `Ledger claims standing:\n${claims.length ? claims.map(claimLine).join("\n") : "  (none)"}\n\n`
    + `Ledger questions open:\n${open.length ? open.map(questionLine).join("\n") : "  (none)"}`;
}

/** For tests: what reads a sent message. `null` puts the real one back. */
let recorder = null;
export function setRecorder(f) { recorder = f; }

/**
 * Write down what a sent reply asserted and asked. Resolves to what it wrote; never rejects.
 * Ids the reader names that are not this conversation's standing rows are ignored.
 */
export async function record({ conversationId, requestId = null, userText = "", reply, log = () => {}, now = clock.now() }) {
  if (!config.saidLedger || !String(reply ?? "").trim()) return null;
  const started = Date.now();
  try {
    const since = now - WINDOW_MS;
    const claims = db.standingClaims(conversationId, { since, limit: 12 });
    const open = db.openQuestions(conversationId, { since, limit: 10 });
    const r = recorder
      ? { value: await recorder({ userText, reply, claims, open }), via: "stub" }
      : await askJson({ system: RECORD_INSTRUCTIONS, prompt: recordPrompt({ userText, reply, claims, open }), schema: RECORD_SCHEMA, name: "ledger", maxTokens: 700 });
    const v = r.value ?? {};
    const out = applyRecord(conversationId, { requestId, value: v, claims, open });
    log({ said_recorded: conversationId, ...out.counts, via: r.via, ms: Date.now() - started });
    for (const c of out.silent) log({ claim_contradicted_silently: c.id, subject: c.subject, was: c.value, conversation: conversationId });
    return out;
  } catch (e) {
    log({ said_record_failed: (e?.message ?? String(e)).split("\n")[0].slice(0, 200), conversation: conversationId, ms: Date.now() - started });
    return null;
  }
}

/** The writes for one reading. Exported so the bookkeeping is provable without a model. */
export function applyRecord(conversationId, { requestId = null, value: v, claims, open }) {
  const standing = new Map(claims.map(c => [c.id, c]));
  const asked = new Map(open.map(q => [q.id, q]));
  const added = [];
  for (const c of (Array.isArray(v.claims) ? v.claims : []).slice(0, 5)) {
    const id = db.addClaim(conversationId, { requestId, subject: c?.subject, value: c?.value, certain: c?.certain !== false });
    if (id) added.push(id);
  }
  const silent = [];
  let superseded = 0;
  for (const s of Array.isArray(v.supersedes) ? v.supersedes : []) {
    const c = standing.get(Number(s?.id));
    if (!c) continue;
    if (db.supersedeClaim(conversationId, c.id, { by: added[0] ?? null, flagged: !!s.flagged })) {
      superseded++;
      if (!s.flagged) silent.push(c);
    }
  }
  let closed = 0;
  for (const x of Array.isArray(v.closes) ? v.closes : []) {
    if (!asked.has(Number(x?.id))) continue;
    closed += db.closeOpenQuestion(conversationId, Number(x.id), x.why);
  }
  let questions = 0;
  for (const q of (Array.isArray(v.questions) ? v.questions : []).slice(0, 3)) if (db.addOpenQuestion(conversationId, { requestId, question: q })) questions++;
  return { counts: { claims: added.length, superseded, closed, questions }, silent };
}

// ---------- right before a reply goes ----------

export const CHECK_INSTRUCTIONS = `You check a draft text from a personal assistant before it is sent. You are shown values the assistant already told the person that still stand, questions it asked that are closed, and the draft. Report:
- changed_silently: ids of standing claims whose value the draft changes, WITHOUT the draft saying out loud that the earlier value changed or was wrong. A draft that says "earlier I said X, it's actually Y" is fine and is not listed. A draft about something else is fine.
- asks_closed: ids of closed questions the draft asks again.`;

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    changed_silently: { type: "array", items: { type: "integer" } },
    asks_closed: { type: "array", items: { type: "integer" } },
  },
  required: ["changed_silently", "asks_closed"],
  additionalProperties: false,
};

/** For tests: what checks a draft. `null` puts the real one back. */
let checker = null;
export function setChecker(f) { checker = f; }

/**
 * Is this draft safe to send against what was already said? `{ ok: true }`, or `{ ok: false, note }`
 * with the instruction for one recompose. Only asked when something is standing or closed in the
 * last few hours, and only over the API (no CLI fallback: a cold CLI start in front of every reply is
 * not cheap). Any failure is ok — this is a backstop, the turn's own block is the main rule.
 */
export async function checkDraft({ conversationId, draft, log = () => {}, now = clock.now() }) {
  try {
    if (!config.saidLedger || !String(draft ?? "").trim()) return { ok: true };
    const since = now - CHECK_WINDOW_MS;
    const claims = db.standingClaims(conversationId, { since, limit: 8 });
    const closed = db.closedQuestions(conversationId, { since, limit: 5 });
    if (!claims.length && !closed.length) return { ok: true };
    if (!checker && !process.env.ANTHROPIC_API_KEY) return { ok: true, skipped: "no_api_key" };
    const started = Date.now();
    const prompt = `Standing claims:\n${claims.length ? claims.map(claimLine).join("\n") : "  (none)"}\n\nClosed questions:\n${closed.length ? closed.map(questionLine).join("\n") : "  (none)"}\n\nThe draft:\n${String(draft).slice(0, 3_000)}`;
    let v;
    try {
      v = checker
        ? await checker({ draft, claims, closed })
        : (await askJson({ system: CHECK_INSTRUCTIONS, prompt, schema: CHECK_SCHEMA, name: "check", cli: false, timeoutMs: config.saidCheckTimeoutMs, maxTokens: 100 })).value;
    } catch (e) {
      log({ said_check_failed: (e?.message ?? String(e)).split("\n")[0].slice(0, 160), conversation: conversationId, ms: Date.now() - started });
      return { ok: true, skipped: "check_failed" };
    }
    const byId = new Map(claims.map(c => [c.id, c]));
    const qById = new Map(closed.map(q => [q.id, q]));
    const changed = (v?.changed_silently ?? []).map(Number).map(id => byId.get(id)).filter(Boolean);
    const reasked = (v?.asks_closed ?? []).map(Number).map(id => qById.get(id)).filter(Boolean);
    log({ said_check: conversationId, changed: changed.map(c => c.id), reasked: reasked.map(q => q.id), ms: Date.now() - started });
    if (!changed.length && !reasked.length) return { ok: true };
    const lines = [
      ...changed.map(c => `It changes what you told them earlier — ${one(c.subject, 80)} was ${one(c.value, 60)} — without saying so. Say it outright: "earlier I said ${one(c.value, 40)}, that was before …; it's …".`),
      ...reasked.map(q => `It asks "${one(q.question, 100)}" again, which is already settled (${String(q.closed_reason ?? "closed").replace(/_/g, " ")}). Do not ask it; give what you found.`),
    ];
    return { ok: false, note: lines.join(" "), changed, reasked };
  } catch {
    return { ok: true };
  }
}
