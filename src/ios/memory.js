// "What I know about you", as JSON (docs/ios-api.md). Listing and correcting are Reason Web's own
// (src/pages/webmemory.js). What is new is the forget: Web's forget retires a row and keeps its words on disk
// so a review can't re-learn them, and here a forget has to mean the words are gone. docs/ios-api.md §Forgetting
// says exactly what that does and does not reach, backups included.
import * as db from "../db.js";
import { memoryView, findRow, forgetRow, correctRow, answerGuess } from "../pages/webmemory.js";
import { clock } from "../config.js";

const ALL = (sql, ...a) => db.db.prepare(sql).all(...a);
const ONE = (sql, ...a) => db.db.prepare(sql).get(...a);
const present = (t) => !!ONE("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const parseIds = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map(Number).filter(n => Number.isInteger(n) && n > 0) : []; } catch { return []; } };

const SOURCE_LABELS = {
  user_stated: "You told me", they_said: "You told me", inferred: "I picked this up from what you said",
  review: "I worked this out from what you said", guess: "My guess — tell me if it's wrong",
};
const quoteOf = (e) => (e?.role === "user" ? String(e.content ?? "").replace(/\s+/g, " ").trim().slice(0, 240) || null : null);
function sourceOf(kind, source, at, quote) {
  return { kind, label: SOURCE_LABELS[kind === "fact" || kind === "rule" ? source : kind] ?? "I picked this up from what you said", at: at ?? null, quote: quote ?? null };
}

/** Every memory, each with where it came from, from the same store every turn reads. */
export function memoriesOf(account) {
  const conv = account.conversation_id;
  const view = memoryView(account);
  const fromFacts = new Map(ALL(`SELECT f.id, f.source, f.source_message_ids FROM person_facts f JOIN people p ON p.id = f.person_id WHERE p.conversation_id = ? AND f.status = 'active'`, conv).map(r => [r.id, r]));
  const rules = new Map(ALL("SELECT id, source, source_message_id FROM treat_rules WHERE conversation_id = ?", conv).map(r => [r.id, r]));
  const whys = new Map(ALL("SELECT id, said FROM whys WHERE conversation_id = ?", conv).map(r => [r.id, r]));
  const wanted = [];
  for (const g of view.groups) for (const r of g.rows) {
    if (r.kind === "fact") wanted.push(...parseIds(fromFacts.get(r.id)?.source_message_ids).slice(-1));
    if (r.kind === "rule" && rules.get(r.id)?.source_message_id) wanted.push(rules.get(r.id).source_message_id);
  }
  const events = new Map(db.eventsByIds(conv, wanted).map(e => [e.id, e]));
  const out = (r, group) => {
    let source;
    if (r.kind === "fact") { const row = fromFacts.get(r.id); source = sourceOf("fact", row?.source, r.at, quoteOf(events.get(parseIds(row?.source_message_ids).at(-1)))); }
    else if (r.kind === "rule") { const row = rules.get(r.id); source = sourceOf("rule", row?.source, r.at, quoteOf(events.get(row?.source_message_id))); }
    else source = { kind: "why", label: SOURCE_LABELS.they_said, at: r.at ?? null, quote: String(whys.get(r.id)?.said ?? "").slice(0, 240) || null };
    return { id: r.key, kind: r.kind, group, text: r.line, about: r.subject || null, source, private: true };
  };
  return {
    empty: view.empty && !view.guesses.length,
    groups: view.groups.map(g => ({ key: g.key, title: g.title, memories: g.rows.map(r => out(r, g.key)) })),
    guesses: view.guesses.map(g => ({ id: `guess-${g.id}`, text: g.text, about: g.subject || null, source: sourceOf("guess", null, null, null), private: true })),
  };
}

/** Run writes that must not linger as freed bytes, then flush them out of the write-ahead log. */
function scrubbed(fn) {
  db.db.exec("PRAGMA secure_delete = ON");
  try {
    return fn();
  } finally {
    db.db.exec("PRAGMA secure_delete = OFF");
    try { db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* the next checkpoint does it */ }
  }
}

/** The row and every older wording it replaced (a correction leaves the old words on a retired row). */
function factLineage(conv, id) {
  const ids = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of ALL(`SELECT f.id, f.superseded_by FROM person_facts f JOIN people p ON p.id = f.person_id WHERE p.conversation_id = ? AND f.superseded_by IS NOT NULL`, conv)) {
      if (ids.has(r.superseded_by) && !ids.has(r.id)) { ids.add(r.id); grew = true; }
    }
  }
  return [...ids];
}

/** Their source messages stop being recallable: the message stays in their thread, its vector goes for good. */
function outOfRecall(conv, eventIds) {
  const mark = db.db.prepare("INSERT OR IGNORE INTO recall_forgotten (conversation_id, source_table, row_id, at) VALUES (?, 'event_log', ?, ?)");
  const spans = db.db.prepare(`DELETE FROM fact_embeddings WHERE conversation_id = ? AND source_table = 'event_log' AND ? BETWEEN COALESCE(span_from, fact_id) AND fact_id RETURNING COALESCE(span_from, fact_id) AS from_id, fact_id AS to_id`);
  const requeue = db.db.prepare("INSERT OR IGNORE INTO recall_reindex (conversation_id, span_from, span_to, at) VALUES (?, ?, ?, ?)");
  const at = clock.now();
  for (const id of new Set(eventIds)) {
    mark.run(conv, id, at);
    for (const r of spans.all(conv, id)) requeue.run(conv, r.from_id, r.to_id, at);
  }
}

/** Every same-subject retired row with the same words (a review's 'superseded', say), which the lineage alone misses. */
function sameWording(personId, fact) {
  const key = db.factKey(fact);
  return ALL("SELECT id, fact FROM person_facts WHERE person_id = ? AND status != 'active'", personId).filter(r => db.factKey(r.fact) === key).map(r => r.id);
}

/** Reason's own copies of the exact words, wherever it wrote them down. Their own messages are left alone. */
function outOfReplies(conv, words) {
  const needle = String(words ?? "").trim();
  if (needle.length <= 3) return;
  const redact = (text) => String(text).replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[deleted at their request]");
  for (const [table, column] of [["event_log", "content"], ["messages", "text"]]) {
    const update = db.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
    for (const r of ALL(`SELECT id, ${column} AS t FROM ${table} WHERE conversation_id = ? AND role != 'user' AND instr(lower(${column}), lower(?)) > 0`, conv, needle)) update.run(redact(r.t), r.id);
  }
}

/**
 * Forget one memory for good. Web's forget first (out of every turn, tool results, Reason's own replies, the
 * profile), then the words themselves come off the row. A fact keeps a one-way mark so the extractor, re-reading
 * the last few messages, can't learn it straight back; only saying it again brings it back.
 */
export async function forgetForever(conv, key, { log = () => {} } = {}) {
  const row = findRow(conv, key);
  if (!row) return { ok: false, status: 404, error: "not_found" };
  const sources = row.kind === "fact" ? factLineage(conv, row.id).flatMap(id => parseIds(ONE("SELECT source_message_ids AS s FROM person_facts WHERE id = ?", id)?.s)) : [];
  const out = await forgetRow(conv, key, { log });
  if (!out.ok) return out;
  scrubbed(() => {
    if (row.kind === "fact") {
      const clear = db.db.prepare("UPDATE person_facts SET fact = ?, status = 'deleted', valid_to = COALESCE(valid_to, ?) WHERE id = ?");
      const unembed = db.db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ? AND source_table = 'person_facts'");
      const person = ONE("SELECT person_id FROM person_facts WHERE id = ?", row.id)?.person_id;
      const ids = new Set(factLineage(conv, row.id));
      for (const id of [...ids]) { const f = ONE("SELECT fact FROM person_facts WHERE id = ?", id); if (f && person != null) for (const same of sameWording(person, f.fact)) ids.add(same); }
      for (const id of ids) {
        const f = ONE("SELECT person_id, fact FROM person_facts WHERE id = ?", id);
        if (!f || db.isForgottenMark(f.fact)) continue;
        db.scrubToolResults(conv, { tools: db.MEMORY_TOOL_NAMES, mentioning: [f.fact] });
        db.redactFromReplies(conv, [f.fact]);
        outOfReplies(conv, f.fact);
        if (present("memories")) db.db.prepare("DELETE FROM memories WHERE conversation_id = ? AND fact = ?").run(conv, f.fact);
        clear.run(db.forgottenMark(f.person_id, db.factKey(f.fact)), clock.now(), id);
        unembed.run(id);
      }
      outOfRecall(conv, sources);
    } else if (row.kind === "rule") {
      // The row stays as 'deleted' with no words: a review refuses to re-derive a rule from that source message.
      outOfReplies(conv, row.raw);
      db.db.prepare("UPDATE treat_rules SET rule = ?, rule_key = ?, why = '' WHERE id = ? AND conversation_id = ?").run(`forgotten-rule-${row.id}`, `forgotten-rule-${row.id}`, row.id, conv);
    } else {
      outOfReplies(conv, row.raw);
      db.db.prepare("DELETE FROM whys WHERE id = ? AND conversation_id = ?").run(row.id, conv);
    }
  });
  log({ ios_memory: "forgotten_forever", kind: row.kind });
  return { ok: true };
}

export { correctRow, answerGuess };

/** The tables that are Reason's memory of one person, plus the thread it reads them from. */
export const MEMORY_TABLES = ["memories", "preferences", "guesses", "whys", "treat_rules", "fact_embeddings", "recall_forgotten", "recall_reindex", "profile_blocks",
  "graph_mentions", "graph_merge_candidates", "graph_edges", "graph_entities", "memory_reviews", "memory_review_passes", "event_log", "messages"];

/**
 * Forget everything Reason knows about this person. Their account, orders, reminders and call records stay
 * (a receipt is a receipt, and a promise keeps running), but Reason can no longer search them.
 */
export function forgetEverything(account, { log = () => {} } = {}) {
  const conv = account.conversation_id;
  const counts = {};
  scrubbed(() => {
    db.db.exec("BEGIN IMMEDIATE");
    try {
      const people = ALL("SELECT id FROM people WHERE conversation_id = ?", conv).map(r => r.id);
      const delFacts = db.db.prepare("DELETE FROM person_facts WHERE person_id = ?");
      counts.person_facts = people.reduce((n, id) => n + Number(delFacts.run(id).changes), 0);
      counts.people = Number(db.db.prepare("DELETE FROM people WHERE conversation_id = ?").run(conv).changes);
      for (const t of MEMORY_TABLES) if (present(t)) counts[t] = Number(db.db.prepare(`DELETE FROM ${t} WHERE conversation_id = ?`).run(conv).changes);
      // Records that stay stop being searchable, so "forget everything" isn't undone by recall reading them.
      const mark = db.db.prepare("INSERT OR IGNORE INTO recall_forgotten (conversation_id, source_table, row_id, at) VALUES (?, ?, ?, ?)");
      const at = clock.now();
      for (const t of ["calls", "action_ledger", "timers"]) for (const r of ALL(`SELECT id FROM ${t} WHERE conversation_id = ?`, conv)) mark.run(conv, t, r.id, at);
      db.db.exec("COMMIT");
    } catch (e) { db.db.exec("ROLLBACK"); throw e; }
    db.clearConversation(conv);
  });
  log({ ios_memory: "forgot_everything" });
  return { ok: true, removed: counts };
}
