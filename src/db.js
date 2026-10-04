// Truth of state lives here, behind tools. The model may only claim what these functions returned.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config, clock } from "./config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    messages TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planning',
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS timers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    fire_at INTEGER NOT NULL,
    note TEXT NOT NULL,
    plan_id INTEGER,
    fired_at INTEGER,
    cancelled_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    about TEXT NOT NULL,
    fact TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  -- Who and what Reason knows about, one row per subject instead of a flat list of strings.
  -- The key column is the normalised name, so "Kofi", "kofi" and "kofi " are one person, not three.
  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(conversation_id, key)
  );
  CREATE TABLE IF NOT EXISTS person_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL,
    fact TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(person_id, fact)
  );
  CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- Every tool action that touched something outside this machine. Append-only.
  -- "What did you do today?" is answered from here, never from the model's memory.
  CREATE TABLE IF NOT EXISTS action_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    attempted TEXT NOT NULL,
    outcome TEXT NOT NULL,
    result TEXT NOT NULL,
    receipt TEXT NOT NULL,
    confirmation_id INTEGER,
    created_at INTEGER NOT NULL
  );
  -- An explicit yes, in the owner's own words, for one described action.
  -- Single use: consumed_at is set the moment a guarded tool spends it.
  CREATE TABLE IF NOT EXISTS confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    stakes TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL DEFAULT '',
    asked_at INTEGER NOT NULL,
    asked_after_msgs INTEGER NOT NULL,
    granted_at INTEGER,
    granted_quote TEXT,
    refused_at INTEGER,
    consumed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS connected_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    connected_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  -- Every time Reason considered reaching out first, and whether it actually did.
  -- This table IS the rate limit: nudgeAllowed counts rows, so restarting the process
  -- cannot reset how often Reason has been nagging.
  CREATE TABLE IF NOT EXISTS nudges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    plan_id INTEGER,
    kind TEXT NOT NULL,
    considered_at INTEGER NOT NULL,
    sent_at INTEGER
  );
  -- A job Reason is working on between messages: an errand, a wait for a reply, a multi-step
  -- thing. The row IS the task, so a restart loses nothing: state and next_wake_at are all a
  -- fresh process needs to pick it back up. attempts counts consecutive crashed steps.
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'running',
    next_wake_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    wakes INTEGER NOT NULL DEFAULT 0,
    last_woken_at INTEGER,
    outcome TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  -- The short progress log. Append-only, and the only thing "what are you working on" may quote.
  CREATE TABLE IF NOT EXISTS task_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'progress',
    note TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  -- One row per conversation that arrived over a channel: which channel, whose number, and
  -- whether that number is the owner's. is_owner is written from config, never from the message,
  -- which is what stops a stranger's thread from authorizing anything.
  CREATE TABLE IF NOT EXISTS threads (
    conversation_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    address TEXT NOT NULL,
    chat_id TEXT,
    is_owner INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- Every inbound webhook event Reason has already handled. The unique key IS the dedupe:
  -- a provider retrying a delivery cannot make Reason answer the same text twice.
  CREATE TABLE IF NOT EXISTS inbound_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    external_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    UNIQUE(channel, external_id)
  );
  -- Every phone call Reason placed, what it was for, and how it went.
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_id TEXT,
    to_number TEXT NOT NULL,
    is_owner INTEGER NOT NULL DEFAULT 0,
    goal TEXT NOT NULL,
    facts TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'placing',
    outcome TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    transcript TEXT NOT NULL DEFAULT '',
    duration_s INTEGER,
    cost_cents INTEGER,
    confirmation_id INTEGER,
    -- What the call opened with, verbatim: that it is an AI assistant, on whose behalf, and
    -- whether it is recorded. Built in code and kept here, so what was disclosed is on the record.
    announcement TEXT NOT NULL DEFAULT '',
    recording_requested INTEGER NOT NULL DEFAULT 0,
    -- 'pending' until the call ends, then 'stored' (there is a file) or 'none' (there is not, and
    -- recording_why says why in plain words). The two must never look alike to the caller:
    -- claiming audio that does not exist is exactly the failure this column prevents.
    recording_state TEXT NOT NULL DEFAULT 'pending',
    recording_file TEXT,
    recording_format TEXT,
    recording_seconds INTEGER,
    recording_bytes INTEGER,
    recording_sha256 TEXT,
    recording_why TEXT NOT NULL DEFAULT '',
    recording_sent_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  -- "Tell me when X" on a page Reason can read. The condition is re-checked on a schedule;
  -- last_seen is what the page said last time, so a change can be noticed rather than guessed.
  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    url TEXT NOT NULL,
    looking_for TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    every_ms INTEGER NOT NULL,
    plan_id INTEGER,
    created_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    last_seen TEXT,
    checks INTEGER NOT NULL DEFAULT 0,
    met_at INTEGER,
    met_why TEXT,
    gave_up_at INTEGER,
    cancelled_at INTEGER
  );
`);

/**
 * CREATE TABLE IF NOT EXISTS leaves an older install's table exactly as it was, so a column
 * added later has to be added by hand. One place for that, run on load.
 */
function addColumnIfMissing(table, column, decl) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
addColumnIfMissing("confirmations", "target", "TEXT NOT NULL DEFAULT ''");
// Recording a call, and the disclosure that goes with it, arrived after calls did.
addColumnIfMissing("calls", "announcement", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "recording_requested", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("calls", "recording_state", "TEXT NOT NULL DEFAULT 'pending'");
addColumnIfMissing("calls", "recording_file", "TEXT");
addColumnIfMissing("calls", "recording_format", "TEXT");
addColumnIfMissing("calls", "recording_seconds", "INTEGER");
addColumnIfMissing("calls", "recording_bytes", "INTEGER");
addColumnIfMissing("calls", "recording_sha256", "TEXT");
addColumnIfMissing("calls", "recording_why", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "recording_sent_at", "INTEGER");

const PLAN_FIELDS = ["title", "kind", "when", "where", "who", "details", "open_questions"];

// ---------- conversations ----------
export function loadConversation(id) {
  const row = db.prepare("SELECT messages FROM conversations WHERE id = ?").get(id);
  return row ? JSON.parse(row.messages) : [];
}
export function saveConversation(id, messages) {
  db.prepare(`INSERT INTO conversations (id, messages, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`)
    .run(id, JSON.stringify(messages), clock.now());
}
export function clearConversation(id) {
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

// ---------- plans ----------
function rowToPlan(r) {
  if (!r) return null;
  return { id: r.id, status: r.status, ...JSON.parse(r.data), created_at: r.created_at, updated_at: r.updated_at };
}
export function createPlan(conversationId, fields) {
  const data = {};
  for (const f of PLAN_FIELDS) data[f] = fields[f] ?? (f === "who" || f === "open_questions" ? [] : f === "details" ? {} : "");
  const now = clock.now();
  const r = db.prepare("INSERT INTO plans (conversation_id, status, data, created_at, updated_at) VALUES (?, 'planning', ?, ?, ?)")
    .run(conversationId, JSON.stringify(data), now, now);
  return getPlan(conversationId, Number(r.lastInsertRowid));
}
export function getPlan(conversationId, id) {
  return rowToPlan(db.prepare("SELECT * FROM plans WHERE id = ? AND conversation_id = ?").get(id, conversationId));
}
export function listPlans(conversationId, { includeClosed = false } = {}) {
  const sql = includeClosed
    ? "SELECT * FROM plans WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 20"
    : "SELECT * FROM plans WHERE conversation_id = ? AND status IN ('planning','locked') ORDER BY updated_at DESC";
  return db.prepare(sql).all(conversationId).map(rowToPlan);
}
export function updatePlan(conversationId, id, changes) {
  const plan = getPlan(conversationId, id);
  if (!plan) return { ok: false, error: `No plan #${id}` };
  if (["cancelled", "done"].includes(plan.status)) return { ok: false, error: `Plan #${id} is ${plan.status}; it can't be changed. Start a new one.` };
  const data = {};
  for (const f of PLAN_FIELDS) data[f] = changes[f] !== undefined ? changes[f] : plan[f];
  db.prepare("UPDATE plans SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(data), clock.now(), id);
  return { ok: true, before: plan, plan: getPlan(conversationId, id) };
}
export function setPlanStatus(conversationId, id, status) {
  const plan = getPlan(conversationId, id);
  if (!plan) return { ok: false, error: `No plan #${id}` };
  const allowed = { planning: ["locked", "cancelled"], locked: ["planning", "cancelled", "done"], cancelled: [], done: [] };
  if (!allowed[plan.status].includes(status)) return { ok: false, error: `Plan #${id} is ${plan.status}; it can't go to ${status}.` };
  if (status === "locked" && plan.open_questions?.length) {
    return { ok: false, error: `Plan #${id} still has open questions: ${plan.open_questions.join("; ")}. Resolve them (plan_update) before locking.` };
  }
  db.prepare("UPDATE plans SET status = ?, updated_at = ? WHERE id = ?").run(status, clock.now(), id);
  return { ok: true, before: plan, plan: getPlan(conversationId, id) };
}

// ---------- timers ----------
export function createTimer(conversationId, { fireAt, note, planId = null }) {
  const r = db.prepare("INSERT INTO timers (conversation_id, fire_at, note, plan_id) VALUES (?, ?, ?, ?)")
    .run(conversationId, fireAt, note, planId);
  return getTimer(conversationId, Number(r.lastInsertRowid));
}
export function getTimer(conversationId, id) {
  return db.prepare("SELECT * FROM timers WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
}
export function listTimers(conversationId) {
  return db.prepare("SELECT * FROM timers WHERE conversation_id = ? AND fired_at IS NULL AND cancelled_at IS NULL ORDER BY fire_at").all(conversationId);
}
export function cancelTimer(conversationId, id) {
  const t = getTimer(conversationId, id);
  if (!t) return { ok: false, error: `No timer #${id}` };
  if (t.fired_at) return { ok: false, error: `Timer #${id} already fired` };
  if (t.cancelled_at) return { ok: false, error: `Timer #${id} was already cancelled` };
  db.prepare("UPDATE timers SET cancelled_at = ? WHERE id = ?").run(clock.now(), id);
  return { ok: true, timer: getTimer(conversationId, id) };
}
export function dueTimers(now = clock.now()) {
  return db.prepare("SELECT * FROM timers WHERE fire_at <= ? AND fired_at IS NULL AND cancelled_at IS NULL ORDER BY fire_at").all(now);
}
export function markTimerFired(id) {
  db.prepare("UPDATE timers SET fired_at = ? WHERE id = ?").run(clock.now(), id);
}

// ---------- memory: people and what is known about them ----------
// `remember` and `recall` look the same to the model as they always did. Behind them the facts now
// hang off a subject instead of piling up as loose strings, which is what makes "what do you know
// about kofi" answerable in one row rather than a substring scan over everything ever said.

export function metaGet(key) {
  return db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key)?.value ?? null;
}
export function metaSet(key, value) {
  db.prepare(`INSERT INTO schema_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

/** One subject, comparable across spelling and spacing. Case and padding are not identity. */
export function personKey(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,!?;:'"]+$/, "");
}

/** Find or create the subject, keeping the first spelling as the display name. */
export function upsertPerson(conversationId, name) {
  const key = personKey(name);
  const existing = db.prepare("SELECT * FROM people WHERE conversation_id = ? AND key = ?").get(conversationId, key);
  if (existing) {
    db.prepare("UPDATE people SET updated_at = ? WHERE id = ?").run(clock.now(), existing.id);
    return db.prepare("SELECT * FROM people WHERE id = ?").get(existing.id);
  }
  const now = clock.now();
  const r = db.prepare("INSERT INTO people (conversation_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(conversationId, String(name).trim(), key, now, now);
  return db.prepare("SELECT * FROM people WHERE id = ?").get(Number(r.lastInsertRowid));
}

export function personFacts(personId) {
  return db.prepare("SELECT id, fact, created_at FROM person_facts WHERE person_id = ? ORDER BY created_at").all(personId);
}

/**
 * Attach one fact to one subject. The same fact twice is one fact: a model that re-learns
 * something it already knew should not make the memory noisier.
 */
export function remember(conversationId, about, fact) {
  const person = upsertPerson(conversationId, about);
  const clean = String(fact).trim();
  const before = db.prepare("SELECT id FROM person_facts WHERE person_id = ? AND fact = ?").get(person.id, clean);
  if (!before) {
    db.prepare("INSERT INTO person_facts (person_id, fact, created_at) VALUES (?, ?, ?)")
      .run(person.id, clean, clock.now());
  }
  return {
    about: person.name, fact: clean, already_knew: !!before,
    knows: personFacts(person.id).map(f => f.fact),
  };
}

/**
 * What is known. With `about`, that subject (exact subject first, then any whose name contains it);
 * without, every subject, most recently touched first.
 */
export function recall(conversationId, about = "") {
  const needle = personKey(about);
  const rows = needle
    ? db.prepare(`SELECT * FROM people WHERE conversation_id = ? AND (key = ? OR key LIKE ?)
        ORDER BY (key = ?) DESC, updated_at DESC LIMIT 10`).all(conversationId, needle, `%${needle}%`, needle)
    : db.prepare("SELECT * FROM people WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 20").all(conversationId);
  return rows.map(p => ({
    about: p.name,
    facts: personFacts(p.id).map(f => ({ fact: f.fact, saved_at: f.created_at })),
  }));
}

export function forgetPerson(conversationId, about) {
  const key = personKey(about);
  const p = db.prepare("SELECT * FROM people WHERE conversation_id = ? AND key = ?").get(conversationId, key);
  if (!p) return { ok: false, error: `Nothing is on record about '${about}'.` };
  const n = personFacts(p.id).length;
  db.prepare("DELETE FROM person_facts WHERE person_id = ?").run(p.id);
  db.prepare("DELETE FROM people WHERE id = ?").run(p.id);
  return { ok: true, about: p.name, forgot: n };
}

/**
 * Moves the old flat memories table into people/person_facts, once. Runs on load so an install
 * from before this change does not quietly lose what it knew. The memories rows are left alone:
 * deleting someone's data is their call, not a migration's.
 */
export function migrateMemoriesToPeople() {
  if (metaGet("memories_moved_to_people")) return { migrated: 0, already_done: true };
  const rows = db.prepare("SELECT conversation_id, about, fact FROM memories ORDER BY created_at").all();
  for (const r of rows) remember(r.conversation_id, r.about, r.fact);
  metaSet("memories_moved_to_people", new Date(clock.now()).toISOString());
  return { migrated: rows.length, already_done: false };
}
migrateMemoriesToPeople();

// ---------- action ledger ----------
export function recordAction({ conversationId, action, target = "", attempted, outcome, result, receipt, confirmationId = null }) {
  const r = db.prepare(`INSERT INTO action_ledger
    (conversation_id, action, target, attempted, outcome, result, receipt, confirmation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, action, target, JSON.stringify(attempted ?? {}), outcome,
         JSON.stringify(result ?? {}), receipt, confirmationId, clock.now());
  return { id: Number(r.lastInsertRowid) };
}
export function listActions(conversationId, { since = null, limit = 50 } = {}) {
  const sql = since
    ? "SELECT * FROM action_ledger WHERE conversation_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?"
    : "SELECT * FROM action_ledger WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?";
  const rows = since
    ? db.prepare(sql).all(conversationId, since, limit)
    : db.prepare(sql).all(conversationId, limit);
  return rows.map(r => ({
    id: r.id, action: r.action, target: r.target, outcome: r.outcome, receipt: r.receipt,
    attempted: JSON.parse(r.attempted), result: JSON.parse(r.result),
    confirmation_id: r.confirmation_id, at: r.created_at,
  }));
}

// ---------- confirmations ----------
export function askConfirmation({ conversationId, action, summary, stakes, target = "", askedAfterMsgs }) {
  const r = db.prepare(`INSERT INTO confirmations
    (conversation_id, action, summary, stakes, target, asked_at, asked_after_msgs) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, action, summary, stakes, target, clock.now(), askedAfterMsgs);
  return getConfirmation(conversationId, Number(r.lastInsertRowid));
}
export function getConfirmation(conversationId, id) {
  return db.prepare("SELECT * FROM confirmations WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
}
export function grantConfirmation(id, quote) {
  db.prepare("UPDATE confirmations SET granted_at = ?, granted_quote = ? WHERE id = ?").run(clock.now(), quote, id);
}
export function refuseConfirmation(id) {
  db.prepare("UPDATE confirmations SET refused_at = ? WHERE id = ?").run(clock.now(), id);
}
export function consumeConfirmation(id) {
  db.prepare("UPDATE confirmations SET consumed_at = ? WHERE id = ?").run(clock.now(), id);
}
export function pendingConfirmations(conversationId) {
  return db.prepare(`SELECT * FROM confirmations WHERE conversation_id = ?
    AND refused_at IS NULL AND consumed_at IS NULL ORDER BY asked_at DESC LIMIT 10`).all(conversationId);
}

// ---------- connected accounts ----------
export function liveAccount(name) {
  return db.prepare("SELECT * FROM connected_accounts WHERE name = ? AND revoked_at IS NULL ORDER BY connected_at DESC LIMIT 1").get(name) ?? null;
}
export function connectAccount(name, scopes) {
  const r = db.prepare("INSERT INTO connected_accounts (name, scopes, connected_at) VALUES (?, ?, ?)")
    .run(name, JSON.stringify(scopes), clock.now());
  return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(Number(r.lastInsertRowid));
}
export function revokeAccount(name) {
  const row = liveAccount(name);
  if (!row) return null;
  db.prepare("UPDATE connected_accounts SET revoked_at = ? WHERE id = ?").run(clock.now(), row.id);
  return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(row.id);
}
export function accountHistory() {
  return db.prepare("SELECT * FROM connected_accounts ORDER BY connected_at DESC").all();
}

// ---------- dropped threads ----------
/**
 * Plans worth raising again: something is still open, and neither the plan nor the conversation
 * has moved for a while. A candidate list, not permission — nudgeAllowed decides that.
 */
export function droppedPlans({ idleMs, now = clock.now() }) {
  const cutoff = now - idleMs;
  return db.prepare(`
    SELECT p.*, c.updated_at AS convo_updated_at FROM plans p
    JOIN conversations c ON c.id = p.conversation_id
    WHERE p.status = 'planning' AND p.updated_at <= ? AND c.updated_at <= ?
    ORDER BY p.updated_at`).all(cutoff, cutoff)
    .map(r => ({ ...rowToPlan(r), conversation_id: r.conversation_id, idle_ms: now - r.convo_updated_at }))
    .filter(p => p.open_questions?.length);
}

/**
 * May Reason reach out about this plan right now? Two limits, both read off the nudges table:
 * the same plan is not raised again inside gapMs, and a conversation gets maxPerDay sent nudges
 * in any rolling 24 hours. Returns the reason when the answer is no, so a caller can log it.
 */
export function nudgeAllowed({ conversationId, planId = null, gapMs, maxPerDay, now = clock.now() }) {
  const last = db.prepare(`SELECT considered_at FROM nudges
    WHERE conversation_id = ? AND plan_id IS ? ORDER BY considered_at DESC LIMIT 1`)
    .get(conversationId, planId);
  if (last && now - last.considered_at < gapMs) {
    return { ok: false, reason: "too_soon_for_this_plan", wait_ms: gapMs - (now - last.considered_at) };
  }
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM nudges
    WHERE conversation_id = ? AND sent_at IS NOT NULL AND sent_at > ?`)
    .get(conversationId, now - 86_400_000);
  if (n >= maxPerDay) return { ok: false, reason: "daily_cap", sent_today: n };
  return { ok: true };
}

/** Records that Reason is about to consider nudging. Written before the turn, so a crash counts. */
export function considerNudge({ conversationId, planId = null, kind }) {
  const r = db.prepare("INSERT INTO nudges (conversation_id, plan_id, kind, considered_at) VALUES (?, ?, ?, ?)")
    .run(conversationId, planId, kind, clock.now());
  return Number(r.lastInsertRowid);
}
export function markNudgeSent(id) {
  db.prepare("UPDATE nudges SET sent_at = ? WHERE id = ?").run(clock.now(), id);
}
export function listNudges(conversationId) {
  return db.prepare("SELECT * FROM nudges WHERE conversation_id = ? ORDER BY considered_at DESC LIMIT 50").all(conversationId);
}

// ---------- tasks ----------
// A task is work that outlives a message. Nothing about it lives in process memory: the state,
// the next wake and the progress log are all rows, so `npm run serve` can be killed mid-errand
// and the next one picks the task up where it was.

export const TASK_OPEN = ["running", "waiting"];

function rowToTask(r) {
  if (!r) return null;
  return {
    ...r,
    open: TASK_OPEN.includes(r.state),
    log: taskLog(r.id),
  };
}

export function createTask(conversationId, { title, goal, wakeAt = null, maxAttempts }) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO tasks
    (conversation_id, title, goal, state, next_wake_at, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`)
    .run(conversationId, title, goal, wakeAt, maxAttempts, now, now);
  const id = Number(r.lastInsertRowid);
  logTask(id, "state", `started: ${goal}`);
  return getTask(conversationId, id);
}

export function getTask(conversationId, id) {
  return rowToTask(db.prepare("SELECT * FROM tasks WHERE id = ? AND conversation_id = ?").get(id, conversationId));
}

/** Used by the sweep, which has an id but no conversation yet. */
export function getTaskAnywhere(id) {
  return rowToTask(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
}

export function listTasks(conversationId, { includeClosed = false } = {}) {
  const sql = includeClosed
    ? "SELECT * FROM tasks WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 30"
    : "SELECT * FROM tasks WHERE conversation_id = ? AND state IN ('running','waiting') ORDER BY created_at LIMIT 30";
  return db.prepare(sql).all(conversationId).map(rowToTask);
}

export function logTask(taskId, kind, note) {
  const r = db.prepare("INSERT INTO task_log (task_id, kind, note, at) VALUES (?, ?, ?, ?)")
    .run(taskId, kind, String(note).slice(0, 600), clock.now());
  return Number(r.lastInsertRowid);
}

export function taskLog(taskId, limit = 12) {
  return db.prepare("SELECT id, kind, note, at FROM task_log WHERE task_id = ? ORDER BY id DESC LIMIT ?")
    .all(taskId, limit).reverse();
}

/**
 * What "something changed" means, in one comparable value: the state, the outcome, and the id of
 * the newest log line. The runtime takes this before a task turn and again after, and that is how
 * code — not the model's say-so — decides whether there was anything to report.
 */
export function taskSignature(id) {
  const t = db.prepare("SELECT state, outcome FROM tasks WHERE id = ?").get(id);
  if (!t) return "gone";
  const last = db.prepare("SELECT MAX(id) AS n FROM task_log WHERE task_id = ?").get(id);
  return `${t.state}|${t.outcome}|${last?.n ?? 0}`;
}

export function updateTask(conversationId, id, { progress = null, wakeAt, state } = {}) {
  const t = getTask(conversationId, id);
  if (!t) return { ok: false, error: `No task #${id}` };
  if (!t.open) return { ok: false, error: `Task #${id} is ${t.state}; it is over. Start a new one.` };
  if (state && !TASK_OPEN.includes(state)) return { ok: false, error: `'${state}' is not an open state. Use task_finish to close a task.` };
  if (progress) logTask(id, "progress", progress);
  const sets = ["updated_at = ?"];
  const args = [clock.now()];
  if (wakeAt !== undefined) { sets.push("next_wake_at = ?"); args.push(wakeAt); }
  if (state) { sets.push("state = ?"); args.push(state); }
  // Real progress clears the crash counter: the retry budget is for a step that keeps dying,
  // not for a task that is simply long.
  if (progress) { sets.push("attempts = 0"); }
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  return { ok: true, task: getTask(conversationId, id) };
}

export function finishTask(conversationId, id, { state, outcome }) {
  const t = getTask(conversationId, id);
  if (!t) return { ok: false, error: `No task #${id}` };
  if (!t.open) return { ok: false, error: `Task #${id} was already ${t.state}.` };
  logTask(id, "state", `${state}: ${outcome}`);
  db.prepare("UPDATE tasks SET state = ?, outcome = ?, next_wake_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?")
    .run(state, String(outcome).slice(0, 600), clock.now(), clock.now(), id);
  return { ok: true, task: getTask(conversationId, id) };
}

/** Tasks whose next wake has come. A task with no next_wake_at is open but not scheduled. */
export function dueTasks(now = clock.now()) {
  return db.prepare(`SELECT * FROM tasks
    WHERE state IN ('running','waiting') AND next_wake_at IS NOT NULL AND next_wake_at <= ?
    ORDER BY next_wake_at`).all(now).map(rowToTask);
}

/**
 * Clears the wake before the turn runs. A crash mid-step therefore leaves the task asleep rather
 * than spinning on every pass, and the retry path is the only thing that schedules it again.
 */
export function markTaskWoken(id) {
  const now = clock.now();
  db.prepare("UPDATE tasks SET next_wake_at = NULL, wakes = wakes + 1, last_woken_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id);
}

export function bumpTaskAttempt(id, { wakeAt }) {
  db.prepare("UPDATE tasks SET attempts = attempts + 1, next_wake_at = ?, updated_at = ? WHERE id = ?")
    .run(wakeAt, clock.now(), id);
  return db.prepare("SELECT attempts, max_attempts FROM tasks WHERE id = ?").get(id);
}

export function scheduleTask(id, wakeAt) {
  db.prepare("UPDATE tasks SET next_wake_at = ?, updated_at = ? WHERE id = ?").run(wakeAt, clock.now(), id);
}

// ---------- threads: which conversation is whose ----------
/**
 * Registers the conversation a channel address maps to. `isOwner` comes from config, never from
 * anything in the message, so no inbound text can promote itself into the owner's thread.
 */
export function upsertThread({ conversationId, channel, address, chatId = null, isOwner }) {
  const now = clock.now();
  db.prepare(`INSERT INTO threads (conversation_id, channel, address, chat_id, is_owner, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      channel = excluded.channel, address = excluded.address,
      chat_id = COALESCE(excluded.chat_id, threads.chat_id),
      is_owner = excluded.is_owner, updated_at = excluded.updated_at`)
    .run(conversationId, channel, address, chatId, isOwner ? 1 : 0, now, now);
  return getThread(conversationId);
}

export function getThread(conversationId) {
  return db.prepare("SELECT * FROM threads WHERE conversation_id = ?").get(conversationId) ?? null;
}

export function listThreads() {
  return db.prepare("SELECT * FROM threads ORDER BY updated_at DESC LIMIT 50").all();
}

/**
 * Is this conversation the owner's? A conversation with no thread row is the console or a test,
 * which is the owner by definition. A row decides every other case, and only `upsertThread`
 * writes that column.
 */
export function isOwnerThread(conversationId) {
  const t = getThread(conversationId);
  return t ? !!t.is_owner : true;
}

/**
 * Records an inbound event id. Returns false when this id has already been handled, which is how
 * a provider's retry stops at the door instead of running a second turn.
 */
export function claimInbound({ channel, externalId, conversationId }) {
  try {
    db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at) VALUES (?, ?, ?, ?)")
      .run(channel, externalId, conversationId, clock.now());
    return true;
  } catch (e) {
    if (/UNIQUE/i.test(e?.message ?? "")) return false;
    throw e;
  }
}

// ---------- calls ----------
export function createCall(conversationId, { provider, toNumber, isOwner, goal, facts, confirmationId = null, announcement = "", recordingRequested = false }) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO calls
    (conversation_id, provider, to_number, is_owner, goal, facts, state, confirmation_id,
     announcement, recording_requested, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'placing', ?, ?, ?, ?, ?)`)
    .run(conversationId, provider, toNumber, isOwner ? 1 : 0, goal, JSON.stringify(facts ?? []), confirmationId,
         announcement, recordingRequested ? 1 : 0, now, now);
  return getCall(conversationId, Number(r.lastInsertRowid));
}

export function getCall(conversationId, id) {
  const r = db.prepare("SELECT * FROM calls WHERE id = ? AND conversation_id = ?").get(id, conversationId);
  return r ? { ...r, facts: JSON.parse(r.facts) } : null;
}

export function listCalls(conversationId, { limit = 20 } = {}) {
  return db.prepare("SELECT * FROM calls WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(conversationId, limit).map(r => ({ ...r, facts: JSON.parse(r.facts) }));
}

export function updateCall(conversationId, id, fields) {
  const allowed = [
    "external_id", "state", "outcome", "summary", "transcript", "duration_s", "cost_cents",
    "recording_state", "recording_file", "recording_format", "recording_seconds",
    "recording_bytes", "recording_sha256", "recording_why",
  ];
  const sets = ["updated_at = ?"];
  const args = [clock.now()];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); args.push(fields[k]); }
  }
  if (fields.state && !["placing", "ringing", "in_progress"].includes(fields.state)) {
    sets.push("ended_at = ?"); args.push(clock.now());
  }
  db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id = ? AND conversation_id = ?`).run(...args, id, conversationId);
  return getCall(conversationId, id);
}

/**
 * Calls on this conversation whose audio is saved and has not gone out yet.
 *
 * This is the queue behind "the owner gets the summary and the recording in one message": the
 * runtime reads it after a turn and attaches whatever is waiting, rather than trusting the model
 * to remember there was audio.
 */
export function callsWithUnsentRecording(conversationId) {
  return db.prepare(
    `SELECT * FROM calls
      WHERE conversation_id = ? AND recording_state = 'stored'
        AND recording_file IS NOT NULL AND recording_sent_at IS NULL
      ORDER BY id ASC`,
  ).all(conversationId).map(r => ({ ...r, facts: JSON.parse(r.facts) }));
}

/** Marked the moment the audio actually leaves, so it is sent once and only once. */
export function markRecordingSent(id) {
  db.prepare("UPDATE calls SET recording_sent_at = ? WHERE id = ?").run(clock.now(), id);
}

/**
 * Every recording file on disk, for export and for delete. Scoped to one conversation or all of
 * them, matching what `data:export` / `data:delete` were asked to cover.
 */
export function recordingFiles(conversationId = null) {
  const sql = conversationId
    ? "SELECT id, conversation_id, recording_file, recording_format, recording_bytes, recording_sha256 FROM calls WHERE recording_file IS NOT NULL AND conversation_id = ? ORDER BY id ASC"
    : "SELECT id, conversation_id, recording_file, recording_format, recording_bytes, recording_sha256 FROM calls WHERE recording_file IS NOT NULL ORDER BY id ASC";
  return (conversationId ? db.prepare(sql).all(conversationId) : db.prepare(sql).all())
    .map(r => ({
      call_id: r.id, conversation_id: r.conversation_id, file: r.recording_file,
      format: r.recording_format, bytes: r.recording_bytes, sha256: r.recording_sha256,
    }));
}

// ---------- watches ----------
export function createWatch(conversationId, { url, lookingFor, note = "", everyMs, planId = null }) {
  const r = db.prepare(`INSERT INTO watches
    (conversation_id, url, looking_for, note, every_ms, plan_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, url, lookingFor, note, everyMs, planId, clock.now());
  return getWatch(conversationId, Number(r.lastInsertRowid));
}
export function getWatch(conversationId, id) {
  return db.prepare("SELECT * FROM watches WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
}
export function listWatches(conversationId, { includeClosed = false } = {}) {
  const sql = includeClosed
    ? "SELECT * FROM watches WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 30"
    : `SELECT * FROM watches WHERE conversation_id = ?
       AND met_at IS NULL AND cancelled_at IS NULL AND gave_up_at IS NULL ORDER BY created_at DESC`;
  return db.prepare(sql).all(conversationId);
}
export function cancelWatch(conversationId, id) {
  const w = getWatch(conversationId, id);
  if (!w) return { ok: false, error: `No watch #${id}` };
  if (w.cancelled_at) return { ok: false, error: `Watch #${id} was already called off` };
  if (w.met_at) return { ok: false, error: `Watch #${id} already found what it was looking for; there is nothing to call off` };
  db.prepare("UPDATE watches SET cancelled_at = ? WHERE id = ?").run(clock.now(), id);
  return { ok: true, watch: getWatch(conversationId, id) };
}
/** Watches whose next check is due: never checked, or last checked a full interval ago. */
export function dueWatches(now = clock.now()) {
  return db.prepare(`SELECT * FROM watches
    WHERE met_at IS NULL AND cancelled_at IS NULL AND gave_up_at IS NULL
      AND (last_checked_at IS NULL OR last_checked_at + every_ms <= ?)
    ORDER BY created_at`).all(now);
}
export function recordWatchCheck(id, { seen = null } = {}) {
  db.prepare("UPDATE watches SET checks = checks + 1, last_checked_at = ?, last_seen = ? WHERE id = ?")
    .run(clock.now(), seen, id);
}
export function markWatchMet(id, why) {
  db.prepare("UPDATE watches SET met_at = ?, met_why = ? WHERE id = ?").run(clock.now(), why ?? "", id);
}
export function markWatchGaveUp(id) {
  db.prepare("UPDATE watches SET gave_up_at = ? WHERE id = ?").run(clock.now(), id);
}
