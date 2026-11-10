// What Reason DID and SAID, searchable by meaning — beside the saved facts.
//
// Until 2026-11-05 recall searched only person_facts. "Do you remember the spa place?" came back
// "nothing saved" two days after Reason had itself called Renew Body Spa (call 52): the call was a
// row in `calls`, never a fact, so no search could reach it. 152 of 345 turns found nothing at all.
//
// So the things Reason did are indexed into the same vector store (fact_embeddings), one row per
// thing, under their own source_table:
//   action_ledger  every outside-world action: lookups, searches, places, pages and links made,
//                  texts sent, orders, calendar entries, check-ins (call rows are below instead)
//   calls          a call once it has ended: who, the number, what for, how it went
//   timers         a one-off reminder or timer they set
//   event_log      the thread itself, one exchange (their message + the reply) per row; fact_id is
//                  the last row of the run and span_from the first
// Only the vector is stored. The words shown are read back from the source row when a match is
// used, so a deleted row cannot come back through here and nothing is copied twice.
//
// SEALED: every write takes the conversation from the source row, and every read is filtered on
// conversation_id — the store query AND each source-row read. One person's Reason never sees a
// row that came from another's.
import { config, clock } from "./config.js";
import { db } from "./db.js";
import { embed, float32ToBlob, blobToFloat32, cosine } from "./embedding.js";

export const SOURCES = ["action_ledger", "calls", "timers", "event_log"];
const MODEL = "text-embedding-3-small";

/**
 * Ledger rows that are bookkeeping, not something a person would ever point back at. call_place
 * and call_recording are covered by the call row itself, which knows how the call went.
 */
const SKIP_ACTIONS = [
  "asked_back", "react", "flagged_content", "harm_refuse", "harm_void", "vault_enroll",
  "call_place", "call_recording", "access_decline", "signin_status", "time_zone", "get_location",
  "pause_everything", "resume_everything",
];
/** Calls still in motion are left until they settle, so the row indexed knows how it went. */
const CALL_SETTLE_MS = 3 * 60_000;
/** A message with no reply yet is left for this long, so the exchange is indexed whole. */
const EXCHANGE_WAIT_MS = 10 * 60_000;
/** One exchange's text, at most. Long replies are mostly their opening anyway. */
const EXCHANGE_CHARS = 1200;
/** What one embedding input may carry. */
const INPUT_CHARS = 1500;
/** Inputs per embeddings request. */
const BATCH = 96;
/** After a failed request, the store is left alone this long: a down API is not hammered. */
const BACKOFF_MS = 5 * 60_000;

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Their words without the lines Reason itself adds to a message ("[3 min ago you showed them …]"). */
function ownWords(content) {
  return String(content ?? "").split("\n").filter(l => !/^\s*\[[^\]]*\]\s*$/.test(l)).join("\n").trim();
}

const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

// ---------- the words for each kind of row ----------

function ledgerText(r) {
  const a = parse(r.attempted);
  // The receipt is the one-line account already written for "what did you do"; the query or URL
  // asked for is added when the receipt leaves it out, so a search finds it by what was looked for.
  const extra = [a.query, a.question, a.url, a.to && a.place_name ? `to ${a.place_name}` : "", a.title, a.summary, a.ask]
    .filter(v => typeof v === "string" && v && !String(r.receipt).includes(v)).join(" · ");
  return clip(`${r.action.replace(/_/g, " ")}: ${r.receipt}${extra ? ` (${extra})` : ""}`, INPUT_CHARS);
}

function callNotes(summary) {
  // The summary opens with the goal again; what the call service heard is the part worth showing.
  const s = String(summary ?? "");
  const i = s.indexOf("notes:");
  return i >= 0 ? s.slice(i + 6) : s;
}

function callText(r) {
  const who = r.label ? `${r.label}, ` : "";
  const dir = r.direction === "in" ? "Took a call from" : "Called";
  return clip(`${dir} ${r.to_number} (${who}${r.state}${r.outcome ? `, ${r.outcome}` : ""}): ${r.goal}. ${callNotes(r.summary)}`, INPUT_CHARS);
}

function timerText(r) {
  const what = r.call_goal ? `call: ${r.call_goal}` : (r.note || r.label || "");
  return clip(`Reminder set for ${new Date(r.fire_at).toISOString().slice(0, 16).replace("T", " ")} UTC: ${what}${r.label && r.note ? ` (${r.label})` : ""}`, INPUT_CHARS);
}

function exchangeText(rows) {
  const lines = rows.map(r => `${r.role === "user" ? "them" : "you"}: ${ownWords(r.content)}`).filter(l => !/^(them|you):\s*$/.test(l));
  return clip(lines.join("\n"), EXCHANGE_CHARS);
}

// ---------- what is not indexed yet ----------

/** Not a row they asked Reason to forget (src/db.js forgetFromRecall). `alias` is the source row's. */
const notForgotten = (alias, table) => `NOT EXISTS (SELECT 1 FROM recall_forgotten f WHERE f.conversation_id = ${alias}.conversation_id AND f.source_table = '${table}' AND f.row_id = ${alias}.id)`;
const forgotten = (conversationId, table, id) => !!db.prepare("SELECT 1 FROM recall_forgotten WHERE conversation_id = ? AND source_table = ? AND row_id = ?").get(conversationId, table, id);

function pendingLedger(conversationId, limit) {
  return db.prepare(`SELECT l.* FROM action_ledger l
    WHERE ${conversationId ? "l.conversation_id = ? AND" : ""} l.action NOT IN (${SKIP_ACTIONS.map(() => "?").join(",")})
      AND NOT EXISTS (SELECT 1 FROM fact_embeddings e WHERE e.fact_id = l.id AND e.source_table = 'action_ledger')
      AND ${notForgotten("l", "action_ledger")}
    ORDER BY l.id LIMIT ?`).all(...(conversationId ? [conversationId] : []), ...SKIP_ACTIONS, limit);
}

function pendingCalls(conversationId, limit, now) {
  return db.prepare(`SELECT c.* FROM calls c
    WHERE ${conversationId ? "c.conversation_id = ? AND" : ""} (c.ended_at IS NOT NULL OR c.state IN ('completed','failed','no_answer','voicemail','busy','canceled','cancelled'))
      AND COALESCE(c.updated_at, c.created_at) <= ?
      AND NOT EXISTS (SELECT 1 FROM fact_embeddings e WHERE e.fact_id = c.id AND e.source_table = 'calls')
      AND ${notForgotten("c", "calls")}
    ORDER BY c.id LIMIT ?`).all(...(conversationId ? [conversationId] : []), now - CALL_SETTLE_MS, limit);
}

function pendingTimers(conversationId, limit) {
  // Standing check-ins make a timer row per firing; the check-in itself is on the ledger (series_set).
  return db.prepare(`SELECT t.* FROM timers t
    WHERE ${conversationId ? "t.conversation_id = ? AND" : ""} t.series_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM fact_embeddings e WHERE e.fact_id = t.id AND e.source_table = 'timers')
      AND ${notForgotten("t", "timers")}
    ORDER BY t.id LIMIT ?`).all(...(conversationId ? [conversationId] : []), limit);
}

/** The thread after the last exchange indexed, cut into exchanges: a message of theirs and what followed it. */
function pendingExchanges(conversationId, limit, now) {
  const convs = conversationId ? [conversationId]
    : db.prepare("SELECT DISTINCT conversation_id FROM event_log WHERE role IN ('user','assistant')").all().map(r => r.conversation_id);
  const out = [];
  for (const c of convs) {
    if (out.length >= limit) break;
    // First the runs a forget took the vector off (src/db.js forgetFromRecall): what is left of each
    // is indexed again, so the lines around a forgotten one are not lost from recall for good.
    for (const q of db.prepare("SELECT span_from, span_to FROM recall_reindex WHERE conversation_id = ? ORDER BY span_from").all(c)) {
      const left = db.prepare(`SELECT id, conversation_id, role, content, at FROM event_log e WHERE conversation_id = ? AND id BETWEEN ? AND ? AND role IN ('user','assistant') AND content <> ''
        AND ${notForgotten("e", "event_log")} ORDER BY id`).all(c, q.span_from, q.span_to);
      if (left.length && exchangeText(left)) out.push({ conversation_id: c, from: left[0].id, to: left.at(-1).id, rows: left, reindex: q.span_from });
      else db.prepare("DELETE FROM recall_reindex WHERE conversation_id = ? AND span_from = ?").run(c, q.span_from);
    }
    const after = db.prepare("SELECT MAX(fact_id) AS m FROM fact_embeddings WHERE conversation_id = ? AND source_table = 'event_log'").get(c)?.m ?? 0;
    // Rows the retention sweep has emptied (src/privacy.js) are skipped in the query, not after it:
    // a window of 400 emptied rows makes no exchange, so `after` would never move past them and
    // nothing said since would ever be indexed.
    // A line they asked Reason to forget is left out of every exchange made from here on.
    const rows = db.prepare(`SELECT id, conversation_id, role, content, at FROM event_log e WHERE conversation_id = ? AND id > ? AND role IN ('user','assistant') AND content <> ''
      AND ${notForgotten("e", "event_log")} ORDER BY id LIMIT 400`).all(c, after);
    let run = [];
    const close = () => {
      if (run.length && exchangeText(run)) out.push({ conversation_id: c, from: run[0].id, to: run.at(-1).id, rows: run });
      run = [];
    };
    for (const r of rows) {
      if (r.role === "user" && run.some(x => x.role === "assistant")) close();
      run.push(r);
    }
    // The newest run is held back while a reply may still be coming, so it is indexed whole.
    if (run.length && (run.some(x => x.role === "assistant") || now - run.at(-1).at > EXCHANGE_WAIT_MS)) {
      // ...and an exchange whose reply is still being written (more may follow) waits a little too.
      if (now - run.at(-1).at > 60_000) close();
    }
  }
  return out.slice(0, limit);
}

let backoffUntil = 0;
let running = null;

/**
 * Index what is not indexed yet: for one conversation, or across all of them. Bounded per pass;
 * a backlog drains over passes. Never throws — a failure is logged and the rows are tried again
 * on a later pass (after a short back-off, so a down API is not hammered).
 */
export async function indexPending({ conversationId = null, limit = 200, embedFn = embed, log = () => {}, now = clock.now() } = {}) {
  if (embedFn === embed && !config.openaiKey) return 0;
  if (now < backoffUntil) return 0;
  if (running) return running;
  running = (async () => {
    let done = 0;
    try {
      const items = [];
      for (const r of pendingCalls(conversationId, limit, now)) items.push({ c: r.conversation_id, id: r.id, table: "calls", text: callText(r), at: r.created_at });
      for (const r of pendingLedger(conversationId, limit)) items.push({ c: r.conversation_id, id: r.id, table: "action_ledger", text: ledgerText(r), at: r.created_at });
      for (const r of pendingTimers(conversationId, limit)) items.push({ c: r.conversation_id, id: r.id, table: "timers", text: timerText(r), at: r.created_at });
      for (const x of pendingExchanges(conversationId, limit, now)) items.push({ c: x.conversation_id, id: x.to, from: x.from, table: "event_log", text: exchangeText(x.rows), reindex: x.reindex });
      const todo = items.slice(0, limit);
      for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        const vectors = await embedFn(batch.map(b => b.text || "(no words)"));
        const put = db.prepare(`INSERT INTO fact_embeddings (conversation_id, fact_id, source_table, embedding, model, created_at, span_from)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fact_id, source_table) DO NOTHING`);
        for (const [j, b] of batch.entries()) {
          if (!vectors[j]) continue;
          put.run(b.c, b.id, b.table, float32ToBlob(vectors[j]), MODEL, now, b.from ?? null);
          if (b.reindex != null) db.prepare("DELETE FROM recall_reindex WHERE conversation_id = ? AND span_from = ?").run(b.c, b.reindex);
          done++;
        }
      }
      if (done) log({ recall_indexed: done, conversation: conversationId ?? "all" });
    } catch (e) {
      backoffUntil = now + BACKOFF_MS;
      log({ recall_index_failed: (e?.message ?? String(e)).split("\n")[0].slice(0, 200), indexed_before_failure: done });
    }
    return done;
  })();
  try { return await running; } finally { running = null; }
}

/** For tests: forget a back-off left by an earlier failure. */
export function resetBackoff() { backoffUntil = 0; }

// ---------- reading back ----------

const dayOf = (at) => at ? new Date(at).toLocaleDateString("en-US", { timeZone: config.tz, month: "short", day: "numeric" }) : "";

/**
 * The words for one stored match, read from its source row — on THIS conversation only. A row
 * that has gone (deleted, or never this conversation's) gives null and the match is dropped.
 */
export function snippetFor(conversationId, table, id, spanFrom = null, { chars = 220 } = {}) {
  // A row they asked Reason to forget is never read back, by meaning or by words.
  if (table !== "event_log" && forgotten(conversationId, table, id)) return null;
  if (table === "action_ledger") {
    const r = db.prepare("SELECT * FROM action_ledger WHERE id = ? AND conversation_id = ?").get(id, conversationId);
    return !r ? null : { kind: "did", at: r.created_at, text: clip(`${r.receipt}${r.outcome && r.outcome !== "ok" ? ` [${r.outcome}]` : ""}`, chars) };
  }
  if (table === "calls") {
    const r = db.prepare("SELECT * FROM calls WHERE id = ? AND conversation_id = ?").get(id, conversationId);
    return !r ? null : { kind: "call", at: r.created_at, text: clip(`${r.direction === "in" ? "took a call from" : "called"} ${r.to_number}${r.label ? ` (${r.label})` : ""}: ${r.goal} → ${r.outcome || r.state}. ${callNotes(r.summary)}`, chars) };
  }
  if (table === "timers") {
    const r = db.prepare("SELECT * FROM timers WHERE id = ? AND conversation_id = ?").get(id, conversationId);
    const state = r?.cancelled_at ? "cancelled" : r?.fired_at ? "went off" : "still set";
    return !r ? null : { kind: "reminder", at: r.created_at, text: clip(`reminder for ${dayOf(r.fire_at)} (${state}): ${r.call_goal || r.note || r.label}`, chars) };
  }
  if (table === "event_log") {
    const rows = db.prepare(`SELECT role, content, at FROM event_log e WHERE conversation_id = ? AND id BETWEEN ? AND ? AND role IN ('user','assistant')
      AND ${notForgotten("e", "event_log")} ORDER BY id`).all(conversationId, spanFrom ?? id, id);
    if (!rows.length) return null;
    const text = clip(exchangeText(rows), chars);
    // Emptied by the retention sweep: there are no words left to show, so no match.
    if (!text) return null;
    return { kind: "thread", at: rows[0].at, text };
  }
  return null;
}

// ---------- ranking ----------
//
// Live proof of 2026-11-06: "spa place" put the real spa call 9th, and the top hit was Reason's own
// earlier "I don't have any spa place saved" reply. A thread exchange repeats the very words they
// use when they point back, so it out-scores the thing it was about; and a "nothing saved" reply,
// handed back as what you said, teaches the model to say it again. So:
//   1. an exchange whose reply says Reason had nothing on it / didn't know is never handed back;
//   2. what Reason DID (a call, a link or page sent, a place looked up, a reminder) ranks above what
//      it SAID, as long as it is a real match (within ACTION_REACH of the best candidate);
//   3. the cut to `limit` comes after that reordering, over up to POOL candidates — not the top
//      few by raw score.
//
// Live again 2026-11-07: "spa place" still put five plain web searches above the call to the spa.
// A search for "spa places near me" says "spa place" too, and it is only Reason reading the web; the
// call is the thing that happened. So among done things, what was ACTED on (a call, a message or
// link sent, a page made, a booking or order, a reminder) ranks above a LOOKUP (a search, a page
// read, a places or flights search) — under the same reach, so a call far below the best match does
// not jump anything. Which kind a row is comes from its record (calls / timers / the ledger action
// name), never from its words.

/** How far below the best match a done thing may score and still rank above the thread. */
const ACTION_REACH = 0.3;
/**
 * Ledger actions that only read the outside world: they find things, they do not do them. Any action
 * not named here (and every call and reminder) counts as acted on.
 */
const LOOKUP_ACTIONS = new Set([
  "web_search", "web_lookup", "research", "browser_open", "browser_click", "nearby_places", "directions",
  "flight_search", "flight_dates", "flight_verify", "offer_check", "video_understand", "image_search",
  "subscriptions_scan", "shop_status", "event_list", "event_guests", "purchase_track",
]);

/** Candidates read back and ranked before the cut. */
const POOL = 60;

const NEG = "(?:don['’]?t|do not|didn['’]?t|did not|haven['’]?t|have not|can['’]?t|cannot|couldn['’]?t|could not)";
/**
 * Reason's own fixed phrasings for "I have nothing on that". Only the "you:" side of an exchange
 * is read — their words are never matched, and this decides nothing about what they meant.
 */
const NOTHING_SAID = [
  /\bnothing (?:saved|noted|stored|on (?:file|record)|in my notes)\b/i,
  /\bnothing (?:on|about) (?:that|it|this)\b/i,
  new RegExp(`\\b${NEG} (?:have|see|find|spot)\\b[^.!?\\n]{0,50}\\b(?:saved|noted|stored|on file|on record|in my notes|a record)\\b`, "i"),
  new RegExp(`\\b${NEG} (?:remember|recall)\\b`, "i"),
  new RegExp(`\\b${NEG} find (?:any|anything)\\b`, "i"),
  /\bno (?:record|memory|note|notes) (?:of|on|about)\b/i,
  /\bI (?:don['’]?t|do not) know (?:which|what|where|who)\b/i,
];

/**
 * True when Reason's LAST reply in an exchange (its last `you: …` line, or the reply text itself)
 * opens by saying it had nothing on it. Only that opening sentence is read, and a sentence that goes
 * on to give something ("couldn't find anything cheaper than $90", "don't know what time, but it's
 * on 23rd") is not a "nothing": a figure or a "but" there means the reply carried an answer.
 */
export function saidNothing(reply) {
  const t = String(reply ?? "");
  const mine = t.includes("\n") || /^(them|you):/.test(t) ? (t.split("\n").filter(l => l.startsWith("you:")).at(-1) ?? "") : t;
  const first = mine.replace(/^you:\s*/, "").trim().split(/(?<=[.!?])\s+|\n/)[0] ?? "";
  if (!first || /\d|\b(?:but|though|however|although)\b/i.test(first)) return false;
  return NOTHING_SAID.some(re => re.test(first));
}

/** Reason's own words in the exchange behind an event_log match — whole, not the clipped snippet. */
function replyOf(conversationId, id, spanFrom) {
  return db.prepare("SELECT content FROM event_log WHERE conversation_id = ? AND id BETWEEN ? AND ? AND role = 'assistant' ORDER BY id")
    .all(conversationId, spanFrom ?? id, id).map(r => `you: ${ownWords(r.content).replace(/\s+/g, " ")}`).join("\n");
}

const isThread = (table) => table === "event_log";

/** True when this action_ledger row only looked something up. */
function isLookup(conversationId, table, id) {
  if (table !== "action_ledger") return false;
  const r = db.prepare("SELECT action FROM action_ledger WHERE id = ? AND conversation_id = ?").get(id, conversationId);
  return !!r && LOOKUP_ACTIONS.has(r.action);
}

/**
 * Candidates ({table, id, spanFrom, score}, best first) → the `limit` handed over: Reason's
 * "nothing saved" exchanges out; then things acted on, then lookups (each only while `reach` keeps
 * it), then the rest in order.
 */
function rankAndCut(conversationId, candidates, { limit, chars, reach = () => true }) {
  const pool = [];
  const seen = new Set();
  for (const s of candidates) {
    if (pool.length >= POOL) break;
    const snip = snippetFor(conversationId, s.table, s.id, s.spanFrom, { chars });
    // The same lookup run twice reads the same; one slot for it.
    if (!snip || seen.has(snip.text)) continue;
    if (isThread(s.table) && saidNothing(replyOf(conversationId, s.id, s.spanFrom))) continue;
    seen.add(snip.text);
    pool.push({ s, snip, lookup: isLookup(conversationId, s.table, s.id) });
  }
  const best = pool.length ? pool[0].s.score : 0;
  const tier = (p) => (isThread(p.s.table) || !reach(p.s.score, best) ? 2 : p.lookup ? 1 : 0);
  // Stable sort: inside a tier the incoming order holds.
  pool.sort((a, b) => tier(a) - tier(b));
  return pool.slice(0, limit);
}

/** The stored rows of THIS conversation closest in meaning to `vector`, done things first. */
export function searchHistory(conversationId, vector, { limit = 4, minScore = 0.35, chars = 220 } = {}) {
  if (!vector || !conversationId) return [];
  const rows = db.prepare(`SELECT fact_id, source_table, span_from, embedding FROM fact_embeddings
    WHERE conversation_id = ? AND source_table IN (${SOURCES.map(() => "?").join(",")})`).all(conversationId, ...SOURCES);
  const scored = [];
  for (const r of rows) {
    const score = cosine(vector, blobToFloat32(r.embedding));
    if (score >= minScore) scored.push({ table: r.source_table, id: r.fact_id, spanFrom: r.span_from, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return rankAndCut(conversationId, scored, { limit, chars, reach: (score, best) => score >= best - ACTION_REACH })
    .map(({ s, snip }) => ({ ...snip, source: s.table, id: s.id, score: Math.round(s.score * 100) / 100, date: dayOf(snip.at) }));
}

/**
 * When the embeddings API is down: the same sources, matched on the longer words of the query.
 * Plain retrieval, not a reading of what they meant — the model still decides that from what comes
 * back. Newest first among equal counts.
 */
const COMMON = new Set(["the", "and", "you", "your", "for", "was", "that", "this", "with", "what", "when", "where", "who", "did", "can", "remember", "about", "from", "have", "had", "are", "one", "place", "thing", "again", "last", "time", "sent", "told"]);
export function keywordHistory(conversationId, query, { limit = 5, chars = 220 } = {}) {
  const words = [...new Set(String(query ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !COMMON.has(w)))].slice(0, 6);
  if (!words.length || !conversationId) return [];
  // pt(): sealed text (src/restcrypt.js) is opened before it is matched; plain text passes through.
  const like = (cols) => `(${words.map(() => `(${cols.map(c => `LOWER(pt(${c})) LIKE ?`).join(" OR ")})`).join(" + ")})`;
  const args = (cols) => words.flatMap(w => cols.map(() => `%${w}%`));
  const found = [];
  const q = (table, cols, extraWhere = "") => db.prepare(`SELECT id, ${like(cols)} AS hits, ${table === "event_log" ? "at" : "created_at"} AS at FROM ${table}
      WHERE conversation_id = ? ${extraWhere} AND ${like(cols)} > 0 ORDER BY hits DESC, id DESC LIMIT ?`)
    .all(...args(cols), conversationId, ...args(cols), Math.max(limit, 20)).map(r => ({ table, ...r }));
  found.push(...q("calls", ["goal", "COALESCE(label,'')", "summary", "to_number"]));
  found.push(...q("action_ledger", ["receipt", "target"], `AND action NOT IN (${SKIP_ACTIONS.map(a => `'${a}'`).join(",")})`));
  found.push(...q("timers", ["COALESCE(note,'')", "COALESCE(label,'')", "COALESCE(call_goal,'')"]));
  found.push(...q("event_log", ["content"], "AND role IN ('user','assistant')"));
  found.sort((a, b) => b.hits - a.hits || b.at - a.at);
  // Word hits have a looser "reach": a done thing that matched at least half as many of the words as
  // the best match ranks above the thread, acted-on before lookups.
  return rankAndCut(conversationId, found.map(f => ({ table: f.table, id: f.id, spanFrom: null, score: f.hits })), { limit, chars, reach: (hits, best) => hits * 2 >= best })
    .map(({ s, snip }) => ({ ...snip, source: s.table, id: s.id, date: dayOf(snip.at) }));
}

