// Truth of state lives here, behind tools. The model may only claim what these functions returned.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
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
    conversation_id TEXT NOT NULL DEFAULT '',
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
  -- One row per PART of an inbound message, which is not the same thing as one row per message.
  --
  -- An iMessage with a link card in it arrives as several receive webhooks ten seconds apart: the
  -- text, then the card's preview images, each with its own handle ending _1, _2. Deciding that
  -- the later ones are previews rather than files somebody sent needs the FIRST part's text, which
  -- may have been handled by a process that has since been restarted. Hence a row rather than
  -- anything in memory. See src/parts.js.
  CREATE TABLE IF NOT EXISTS inbound_parts (
    channel TEXT NOT NULL,
    base_handle TEXT NOT NULL,
    part_index INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    -- JSON arrays: every URL in this part's own text, and what was attached to it.
    urls TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]',
    at INTEGER NOT NULL,
    PRIMARY KEY (channel, base_handle, part_index)
  );
  -- Messages that have arrived and are waiting a moment to see whether more of the same thought is
  -- coming. Everything held for one conversation runs as ONE turn.
  --
  -- A row rather than a list in memory, because the window is the whole point: a process that dies
  -- two seconds into somebody's burst must not lose what they said. The next process's sweep finds
  -- these rows past their ready_at and runs the turn.
  --
  --   ready_at     when the turn may run. Pushed forward by each new message from the same person.
  --   deadline_at  the furthest ready_at may ever be pushed, counted from the FIRST message of the
  --                burst. Without it somebody typing continuously would never get an answer.
  --
  -- Rows are deleted the moment they are taken for a turn, which is the same bargain claimInbound
  -- makes: a crash mid-turn loses the turn rather than running it twice.
  CREATE TABLE IF NOT EXISTS pending_inbound (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    address TEXT NOT NULL,
    chat_id TEXT,
    external_id TEXT NOT NULL,
    text TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    service TEXT,
    is_operator INTEGER NOT NULL DEFAULT 0,
    arrived_at INTEGER NOT NULL,
    ready_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pending_inbound_due ON pending_inbound (ready_at);
  -- Every message Reason tried to put in front of somebody, and what became of it.
  --
  -- This table exists because a reply that fails to send used to be logged and dropped — the first
  -- real text anybody sent Reason was lost that way. A message is a row before it is an attempt,
  -- so the process can die at any point and the next one knows what was owed to whom.
  --
  -- state is one of:
  --   queued     waiting for an attempt. next_attempt_at says when.
  --   sending    an attempt is in flight RIGHT NOW. A row left in this state is a crash.
  --   unknown    it was 'sending' when the process stopped. Nobody knows whether it arrived, so
  --              nothing is resent until the provider is asked (see channel.findSent).
  --   sent       it went. message_id is the provider's handle for it.
  --   failed     it is never going. last_error says why, in words Reason can repeat.
  --
  -- idem_key is what makes "never twice" true, and it has to be enforced here because Sendblue's
  -- send endpoint has no idempotency key of its own: one row per logical message, one in-flight
  -- attempt per row, and a row that reached 'sent' is never attempted again.
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idem_key TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    address TEXT NOT NULL,
    chat_id TEXT,
    body TEXT NOT NULL,
    -- JSON {file, mimeType, filename} when this message carries an attachment, else NULL.
    media TEXT,
    -- An iMessage screen effect for this one message, or NULL. Stored rather than applied at the
    -- call site so a message that is retried an hour later still goes out the way it was meant to.
    send_style TEXT,
    state TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_attempt_at INTEGER,
    last_error TEXT NOT NULL DEFAULT '',
    last_error_key TEXT,
    last_error_code TEXT,
    message_id TEXT,
    -- Whose message this was. A failure to reach the person whose Reason this is gets told to them
    -- on their next turn; a failure to reach ANYONE ELSE also has to reach the account owner,
    -- because Reason told them it would text that person.
    to_owner INTEGER NOT NULL DEFAULT 0,
    -- Stamped when the bad news has been delivered, so it is delivered exactly once.
    told_at INTEGER,
    owner_told_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sent_at INTEGER,
    failed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS outbox_due ON outbox (state, next_attempt_at);
  CREATE INDEX IF NOT EXISTS outbox_thread ON outbox (conversation_id, state);
  -- Things a provider has already said it will not do, so it is not asked again every message.
  --
  -- Read receipts, tapbacks and expressive effects are all best-effort extras, and each has a
  -- refusal that is a permanent fact rather than a bad moment: a Sendblue line that answers 422
  -- unsupported_on_this_line will answer it for every contact forever, and only their support can
  -- change that. Asking anyway on every inbound message would be a wasted request and a log line
  -- per message about something nobody can fix from here.
  --
  -- scope is what the refusal is actually about, and getting it wrong in either direction is a
  -- real bug: remembering a per-contact refusal against the line switches a working feature off for
  -- everybody, and remembering a per-line refusal against one contact keeps on asking.
  --   'line:+1555...'      the Sendblue number. True for every conversation on it.
  --   'contact:+1555...'   one person.
  --
  -- Only permanent refusals belong here. A 503 or a 429 is "not now" and is deliberately forgotten.
  CREATE TABLE IF NOT EXISTS channel_limits (
    channel TEXT NOT NULL,
    feature TEXT NOT NULL,
    scope TEXT NOT NULL,
    why TEXT NOT NULL DEFAULT '',
    code TEXT,
    learned_at INTEGER NOT NULL,
    PRIMARY KEY (channel, feature, scope)
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
    -- The unguessable half of this call's own webhook address. A provider is handed
    -- {public url}/calls/{provider}/webhook/{token} when it places the call, so a delivery that
    -- arrives knows which call it is about without trusting anything in its body, and a token that
    -- is not in this column is answered exactly like a URL that was never issued.
    webhook_token TEXT,
    -- 'pending' until the call ends, then one of:
    --   'stored'          there is a file, and recording_file points at it
    --   'missing'         the call was answered and the audio is NOT there — an error state, told
    --                     to the owner and written to the ledger as a failure
    --   'not_applicable'  nobody was on the call to record (never connected, no answer, busy)
    -- Every call is recorded, so 'missing' is a fault rather than a configuration. These must
    -- never look alike to the caller: claiming audio that does not exist, or shrugging at audio
    -- that should, are the two failures this column exists to prevent.
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
  -- One person's Reason. The conversation id is the scope key everything else is already keyed
  -- by, so an account is a conversation and the isolation is the scoping that was always there.
  CREATE TABLE IF NOT EXISTS accounts (
    conversation_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    address TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    is_operator INTEGER NOT NULL DEFAULT 0,
    -- active | paused | removed. Paused and removed both stop Reason answering; neither deletes
    -- anything, because "stop" and "destroy" are different instructions and the master gives them
    -- separately. Deleting is data_delete, which is the same per-person delete as always.
    state TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    UNIQUE(channel, address)
  );
  -- Somebody asking for a Reason of their own. Anyone may text the number; nothing they said
  -- reaches the model until the master has said yes, so their first message lives here as a quote
  -- rather than as a turn. One request per number at a time.
  CREATE TABLE IF NOT EXISTS access_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    address TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    first_message TEXT NOT NULL,
    chat_id TEXT,
    -- pending | approved | declined | expired
    state TEXT NOT NULL DEFAULT 'pending',
    requested_at INTEGER NOT NULL,
    announced_at INTEGER,
    told_waiting_at INTEGER,
    decided_at INTEGER,
    -- The confirmation in the master's own conversation that this request is tied to. One yes,
    -- one request: this column is what stops a yes meant for one person letting in another.
    confirmation_id INTEGER
  );
  -- Numbers the master has shut out for good. Checked before anything else, so a blocked number
  -- costs nothing and is never announced again.
  CREATE TABLE IF NOT EXISTS blocked_numbers (
    address TEXT PRIMARY KEY,
    blocked_at INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );
  -- What each person has used today. The operator pays for every turn, so this is a real limit
  -- counted in a table, not a number held in memory that a restart would forget.
  CREATE TABLE IF NOT EXISTS usage (
    conversation_id TEXT NOT NULL,
    day TEXT NOT NULL,
    turns INTEGER NOT NULL DEFAULT 0,
    proactive INTEGER NOT NULL DEFAULT 0,
    -- Phone calls, counted two ways because they cost money two ways: one per call placed, and one
    -- per second actually spent on the line. The seconds are added when a call FINISHES, which is
    -- the first moment its real length exists.
    calls INTEGER NOT NULL DEFAULT 0,
    call_seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, day)
  );
  -- Numbers told it is invite-only, so they are told once rather than on every message.
  CREATE TABLE IF NOT EXISTS turned_away (
    address TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  -- A small web page Reason made: an answer that was too long or too visual for a text.
  -- content is the checked block list - see src/pages/content.js, never HTML. id is unguessable
  -- because for a private page the link is the first half of the secret and the code is the second.
  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- A browser that has proved it holds the one-time code. Per page, so a code for one page does
  -- not quietly open every other one.
  CREATE TABLE IF NOT EXISTS page_sessions (
    token TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  -- The one-time codes themselves, and every attempt at one. The attempts are what the rate limit
  -- is counted from, so guessing is bounded by a table rather than by whatever is in memory.
  CREATE TABLE IF NOT EXISTS page_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    code TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS page_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    ok INTEGER NOT NULL
  );
  -- What the owner pressed on a page. delivered_at is what makes a pick reach Reason exactly
  -- once: the sweep claims it before the turn runs.
  CREATE TABLE IF NOT EXISTS page_choices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    block_key TEXT NOT NULL,
    question TEXT NOT NULL DEFAULT '',
    picked TEXT NOT NULL,
    at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  -- Every URL that has come back from a real tool result in this conversation. A picture may only
  -- go on a page if its address is in here, so the model cannot type one from memory.
  CREATE TABLE IF NOT EXISTS seen_urls (
    conversation_id TEXT NOT NULL,
    url TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, url)
  );
  -- One research run: a question, the queries still to run, and how much of the budget it has
  -- spent. The row IS the run, so a deep one picks back up after a restart with its whole source
  -- log intact. task_id links it to the tasks machinery when it is a durable one.
  CREATE TABLE IF NOT EXISTS research (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    question TEXT NOT NULL,
    task_id INTEGER,
    state TEXT NOT NULL DEFAULT 'open',
    queries TEXT NOT NULL DEFAULT '[]',
    searches INTEGER NOT NULL DEFAULT 0,
    cut_short TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  -- The source log: every url this run touched, what it really said, and what happened to it.
  -- Append-only, and the only thing an answer may cite. The state column is the honest part:
  --   read      the page was fetched and said is text that really came back
  --   found     a search returned it; said is the provider's snippet, the page was not read
  --   forbidden the site's robots.txt disallows fetching it, so only the snippet exists
  --   failed    it was allowed and would not load; why is what went wrong
  CREATE TABLE IF NOT EXISTS research_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    research_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    site TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    said TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '',
    via TEXT NOT NULL,
    state TEXT NOT NULL,
    why TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL,
    UNIQUE (research_id, url, state)
  );
  -- Every query a run really ran, so "it searched four times" is counted rather than claimed.
  CREATE TABLE IF NOT EXISTS research_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    research_id INTEGER NOT NULL,
    query TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  -- Accounts of a video that Reason paid a model to produce, keyed by the video AND the tier,
  -- because watching a video and transcribing its audio are different answers about the same thing.
  -- Deliberately NOT scoped per person: an account of a public video is not anybody's private
  -- content, and scoping it would mean paying again for every person who sends the same link.
  -- Nothing in here came out of a conversation. Captions are free, so they are never cached.
  CREATE TABLE IF NOT EXISTS video_accounts (
    video_key TEXT NOT NULL,      -- "<extractor>:<id>", so two sites cannot collide
    tier TEXT NOT NULL,           -- "watch" (saw the video) | "listen" (audio only)
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    seconds REAL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (video_key, tier)
  );
  -- The shape this replaced, from earlier the same day. It never ran anywhere: tier 2 was rebuilt
  -- before any install had it, so there is nothing in it to migrate and dropping it loses nothing.
  DROP TABLE IF EXISTS video_transcripts;
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
// The owner's own link carries a key, so tapping it opens the page with nothing to type.
addColumnIfMissing("pages", "owner_key", "TEXT");
// Recording a call, and the disclosure that goes with it, arrived after calls did.
addColumnIfMissing("calls", "announcement", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "recording_state", "TEXT NOT NULL DEFAULT 'pending'");
addColumnIfMissing("calls", "recording_file", "TEXT");
addColumnIfMissing("calls", "recording_format", "TEXT");
addColumnIfMissing("calls", "recording_seconds", "INTEGER");
addColumnIfMissing("calls", "recording_bytes", "INTEGER");
addColumnIfMissing("calls", "recording_sha256", "TEXT");
addColumnIfMissing("calls", "recording_why", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "recording_sent_at", "INTEGER");
addColumnIfMissing("calls", "webhook_token", "TEXT");
addColumnIfMissing("usage", "calls", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("usage", "call_seconds", "INTEGER NOT NULL DEFAULT 0");
// Connected accounts used to be install-wide, from when there was only ever one person. With a
// Reason per person that is a leak, so they are scoped now. An older install's rows belong to the
// operator, which is whose they were.
addColumnIfMissing("connected_accounts", "conversation_id", "TEXT NOT NULL DEFAULT ''");
// Which rail a thread is on, and the handle of the last message from them: what a tapback and an
// expressive effect need, and both arrived after threads did.
addColumnIfMissing("threads", "service", "TEXT");
addColumnIfMissing("threads", "last_inbound_id", "TEXT");
addColumnIfMissing("outbox", "send_style", "TEXT");
// Inline replies: what each inbound message said (so "the one about the table" can be found again
// by its words), which message an outbound one is pinned under, and the message this turn's reply
// has been pointed at. See src/replies.js.
addColumnIfMissing("inbound_messages", "text", "TEXT");
addColumnIfMissing("outbox", "reply_to", "TEXT");
addColumnIfMissing("threads", "reply_target", "TEXT");
db.prepare("UPDATE connected_accounts SET conversation_id = ? WHERE conversation_id = ''").run(config.ownerConversation);

/**
 * The operator's account, created from config on first load.
 *
 * This is the whole of the migration: everything already in the database is under
 * `config.ownerConversation`, and that conversation becomes the operator's account. No rows move.
 */
function seedOperatorAccount() {
  const id = config.ownerConversation;
  if (db.prepare("SELECT 1 FROM accounts WHERE conversation_id = ?").get(id)) return;
  const address = config.operatorNumbers[0] ?? "console";
  db.prepare(`INSERT OR IGNORE INTO accounts (conversation_id, channel, address, name, is_operator, created_at)
    VALUES (?, ?, ?, ?, 1, ?)`)
    .run(id, config.operatorNumbers.length ? "linq" : "console", address, config.ownerName, clock.now());
}
seedOperatorAccount();

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
export function liveAccount(conversationId, name) {
  return db.prepare("SELECT * FROM connected_accounts WHERE conversation_id = ? AND name = ? AND revoked_at IS NULL ORDER BY connected_at DESC LIMIT 1").get(conversationId, name) ?? null;
}
export function connectAccount(conversationId, name, scopes) {
  const r = db.prepare("INSERT INTO connected_accounts (conversation_id, name, scopes, connected_at) VALUES (?, ?, ?, ?)")
    .run(conversationId, name, JSON.stringify(scopes), clock.now());
  return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(Number(r.lastInsertRowid));
}
export function revokeAccount(conversationId, name) {
  const row = liveAccount(conversationId, name);
  if (!row) return null;
  db.prepare("UPDATE connected_accounts SET revoked_at = ? WHERE id = ?").run(clock.now(), row.id);
  return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(row.id);
}
export function accountHistory(conversationId) {
  return db.prepare("SELECT * FROM connected_accounts WHERE conversation_id = ? ORDER BY connected_at DESC").all(conversationId);
}

// ---------- accounts: one Reason per person ----------
export function getAccount(conversationId) {
  return db.prepare("SELECT * FROM accounts WHERE conversation_id = ?").get(conversationId) ?? null;
}

export function accountByAddress(channel, address) {
  return db.prepare("SELECT * FROM accounts WHERE channel = ? AND address = ?").get(channel, address) ?? null;
}

export function upsertAccount({ conversationId, channel, address, name = "", isOperator = false }) {
  const now = clock.now();
  db.prepare(`INSERT INTO accounts (conversation_id, channel, address, name, is_operator, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      name = CASE WHEN excluded.name != '' THEN excluded.name ELSE accounts.name END,
      -- The channel and address are updated, not kept. Somebody's seeded or old row saying 'linq'
      -- while they are actually texting over something else is a row Reason cannot reach them on,
      -- which is how the master silently stopped getting their own access questions.
      channel = excluded.channel,
      address = CASE WHEN excluded.address != '' THEN excluded.address ELSE accounts.address END`)
    .run(conversationId, channel, address, name, isOperator ? 1 : 0, now, now);
  return getAccount(conversationId);
}

/** The name a person told Reason to call them. Only ever their own row. */
export function setAccountName(conversationId, name) {
  const n = String(name ?? "").trim().slice(0, 80);
  if (!n) return null;
  const r = db.prepare("UPDATE accounts SET name = ? WHERE conversation_id = ?").run(n, conversationId);
  return r.changes ? getAccount(conversationId) : null;
}

export function listAccountsOfPeople() {
  return db.prepare("SELECT * FROM accounts ORDER BY is_operator DESC, created_at ASC").all();
}

export function deleteAccount(conversationId) {
  const row = getAccount(conversationId);
  if (!row) return null;
  db.prepare("DELETE FROM accounts WHERE conversation_id = ?").run(conversationId);
  return row;
}

// ---------- asking for a Reason, and the master's answer ----------
export function createAccessRequest({ channel, address, displayName = "", firstMessage, chatId = null }) {
  const r = db.prepare(`INSERT INTO access_requests
    (channel, address, display_name, first_message, chat_id, state, requested_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
    .run(channel, address, displayName, firstMessage, chatId, clock.now());
  return getAccessRequest(Number(r.lastInsertRowid));
}

export function getAccessRequest(id) {
  return db.prepare("SELECT * FROM access_requests WHERE id = ?").get(id) ?? null;
}

/** The live request for a number, if any. One at a time per number. */
export function pendingRequestFor(address) {
  return db.prepare("SELECT * FROM access_requests WHERE address = ? AND state = 'pending' ORDER BY id DESC LIMIT 1").get(address) ?? null;
}

/** The most recent decision about a number, for the decline cool-off. */
export function lastDecisionFor(address) {
  return db.prepare("SELECT * FROM access_requests WHERE address = ? AND state IN ('declined','approved','expired') ORDER BY decided_at DESC LIMIT 1").get(address) ?? null;
}

export function listAccessRequests({ state = "pending", limit = 50 } = {}) {
  return state === "all"
    ? db.prepare("SELECT * FROM access_requests ORDER BY id DESC LIMIT ?").all(limit)
    : db.prepare("SELECT * FROM access_requests WHERE state = ? ORDER BY id ASC LIMIT ?").all(state, limit);
}

/**
 * The one request currently in front of the master: announced, still pending, with a confirmation.
 * Only ever one, which is what makes "which request did that yes mean" answerable in code.
 */
export function announcedRequest() {
  return db.prepare("SELECT * FROM access_requests WHERE state = 'pending' AND announced_at IS NOT NULL AND confirmation_id IS NOT NULL ORDER BY id ASC LIMIT 1").get() ?? null;
}

/** Pending requests nobody has put to the master yet. */
export function unannouncedRequests() {
  return db.prepare("SELECT * FROM access_requests WHERE state = 'pending' AND announced_at IS NULL ORDER BY id ASC").all();
}

export function markRequestAnnounced(id, confirmationId) {
  db.prepare("UPDATE access_requests SET announced_at = ?, confirmation_id = ? WHERE id = ?")
    .run(clock.now(), confirmationId, id);
  return getAccessRequest(id);
}

export function requestsAnnouncedSince(sinceMs) {
  return db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE announced_at >= ?").get(sinceMs).n;
}

export function decideRequest(id, state) {
  db.prepare("UPDATE access_requests SET state = ?, decided_at = ? WHERE id = ?").run(state, clock.now(), id);
  return getAccessRequest(id);
}

export function markToldWaiting(id) {
  db.prepare("UPDATE access_requests SET told_waiting_at = ? WHERE id = ?").run(clock.now(), id);
}

// ---------- blocked for good ----------
export function blockNumber(address, note = "") {
  db.prepare("INSERT INTO blocked_numbers (address, blocked_at, note) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET note = excluded.note")
    .run(address, clock.now(), note);
  // A block ends any live request, so it is never put to the master again.
  db.prepare("UPDATE access_requests SET state = 'declined', decided_at = ? WHERE address = ? AND state = 'pending'")
    .run(clock.now(), address);
  return true;
}
export function isBlocked(address) {
  return !!db.prepare("SELECT 1 FROM blocked_numbers WHERE address = ?").get(address);
}
export function unblockNumber(address) {
  return db.prepare("DELETE FROM blocked_numbers WHERE address = ?").run(address).changes > 0;
}
export function listBlocked() {
  return db.prepare("SELECT * FROM blocked_numbers ORDER BY blocked_at DESC").all();
}

// ---------- an account's state ----------
export function setAccountState(conversationId, state) {
  db.prepare("UPDATE accounts SET state = ? WHERE conversation_id = ?").run(state, conversationId);
  return getAccount(conversationId);
}

// ---------- what each person has used ----------
/** The only column names bumpUsage will ever interpolate. Nothing a caller passes reaches SQL. */
const USAGE_COLUMNS = new Set(["turns", "proactive", "calls", "call_seconds"]);

export function usageToday(conversationId, day) {
  return db.prepare("SELECT turns, proactive, calls, call_seconds FROM usage WHERE conversation_id = ? AND day = ?").get(conversationId, day)
    ?? { turns: 0, proactive: 0, calls: 0, call_seconds: 0 };
}
/**
 * Add to one of today's counters. `by` is 1 for anything counted per event; call seconds come in
 * as however many seconds the call really ran.
 */
export function bumpUsage(conversationId, day, column, by = 1) {
  const col = USAGE_COLUMNS.has(column) ? column : "turns";
  const n = Math.max(0, Math.round(Number(by) || 0));
  if (!n) return usageToday(conversationId, day);
  db.prepare(`INSERT INTO usage (conversation_id, day, ${col}) VALUES (?, ?, ?)
    ON CONFLICT(conversation_id, day) DO UPDATE SET ${col} = ${col} + ?`).run(conversationId, day, n, n);
  return usageToday(conversationId, day);
}
export function usageFor(conversationId, { days = 7 } = {}) {
  return db.prepare("SELECT day, turns, proactive, calls, call_seconds FROM usage WHERE conversation_id = ? ORDER BY day DESC LIMIT ?")
    .all(conversationId, days);
}

export function recordTurnedAway(address) {
  db.prepare("INSERT INTO turned_away (address, at) VALUES (?, ?)").run(address, clock.now());
}
export function lastTurnedAway(address) {
  return db.prepare("SELECT MAX(at) AS at FROM turned_away WHERE address = ?").get(address)?.at ?? null;
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

/**
 * Tasks that were mid-step when the process stopped, given a wake time again.
 *
 * `markTaskWoken` clears `next_wake_at` *before* the turn runs, which is what stops a task
 * firing twice. The cost is that a process killed mid-turn leaves the task open with no wake —
 * asleep for good, which is the worst way to lose work: silently. So this is run on every start
 * and on a graceful shutdown, and anything open with no wake gets one.
 *
 * Returns how many were rescued, which is worth logging: a number other than zero means the last
 * stop was not clean.
 */
export function rescueOrphanedTasks(wakeAt) {
  const rows = db.prepare("SELECT id, title FROM tasks WHERE state IN ('running','waiting') AND next_wake_at IS NULL").all();
  if (rows.length) {
    db.prepare("UPDATE tasks SET next_wake_at = ?, updated_at = ? WHERE state IN ('running','waiting') AND next_wake_at IS NULL")
      .run(wakeAt, clock.now());
  }
  return rows;
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
/**
 * `service` and `lastInboundId` are what the iMessage-only extras need, and they are stored rather
 * than passed around because the model reaches for them a turn later than the message arrived:
 *
 *   service        which rail this thread is on. A tapback and an expressive effect are iMessage
 *                  only, so on an SMS thread they can be refused before a request is made rather
 *                  than collecting a 422 every time.
 *   lastInboundId  the provider's handle for the most recent message FROM them. A tapback can only
 *                  go on a message Reason received, and the handle is the only way to name one —
 *                  nothing in the message text identifies it.
 *
 * Both are COALESCEd, so a channel that reports neither never blanks what was already known.
 */
export function upsertThread({ conversationId, channel, address, chatId = null, isOwner, service = null, lastInboundId = null }) {
  const now = clock.now();
  db.prepare(`INSERT INTO threads (conversation_id, channel, address, chat_id, is_owner, service, last_inbound_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      channel = excluded.channel, address = excluded.address,
      chat_id = COALESCE(excluded.chat_id, threads.chat_id),
      service = COALESCE(excluded.service, threads.service),
      last_inbound_id = COALESCE(excluded.last_inbound_id, threads.last_inbound_id),
      is_owner = excluded.is_owner, updated_at = excluded.updated_at`)
    .run(conversationId, channel, address, chatId, isOwner ? 1 : 0, service, lastInboundId, now, now);
  return getThread(conversationId);
}

export function getThread(conversationId) {
  return db.prepare("SELECT * FROM threads WHERE conversation_id = ?").get(conversationId) ?? null;
}

export function listThreads() {
  return db.prepare("SELECT * FROM threads ORDER BY updated_at DESC LIMIT 50").all();
}

// ---------- inline replies: which message is which ----------
/**
 * One message in a conversation, by the provider's handle for it — theirs or Reason's.
 *
 * Scoped to the conversation, so a handle from somebody else's thread finds nothing: an inline
 * reply can only ever be pinned under, or read against, a message in the thread it belongs to.
 * Case is ignored because Sendblue's own examples show the same kind of handle in both cases.
 */
export function messageByHandle(conversationId, handle) {
  const h = String(handle ?? "");
  if (!h) return null;
  const theirs = db.prepare("SELECT external_id AS handle, text, received_at AS at FROM inbound_messages WHERE conversation_id = ? AND external_id = ? COLLATE NOCASE").get(conversationId, h);
  if (theirs) return { ...theirs, text: theirs.text ?? "", from: "them" };
  const ours = db.prepare("SELECT message_id AS handle, body AS text, sent_at AS at FROM outbox WHERE conversation_id = ? AND message_id = ? COLLATE NOCASE AND state = 'sent'").get(conversationId, h);
  return ours ? { ...ours, from: "reason" } : null;
}

/**
 * The most recent messages in a conversation that have a handle, newest first, both directions.
 * Only Reason's messages to the person whose thread this is: a text to somebody else lives in
 * their thread on their phone, and cannot be replied under here.
 */
export function recentMessages(conversationId, { limit = 200 } = {}) {
  // `seq` breaks a tie between two of their texts that landed in the same millisecond — which is
  // exactly what a burst is — so "the newest" is the one that arrived last, not whichever SQLite
  // happened to return first.
  return db.prepare(`
    SELECT external_id AS handle, COALESCE(text, '') AS text, received_at AS at, 'them' AS "from", id AS seq
      FROM inbound_messages WHERE conversation_id = ?
    UNION ALL
    SELECT message_id AS handle, body AS text, sent_at AS at, 'reason' AS "from", id AS seq
      FROM outbox WHERE conversation_id = ? AND state = 'sent' AND message_id IS NOT NULL AND to_owner = 1
    ORDER BY at DESC, seq DESC LIMIT ?`).all(conversationId, conversationId, limit);
}

/** Point this conversation's next reply at one message. Null takes the pointer away. */
export function setReplyTarget(conversationId, handle) {
  db.prepare("UPDATE threads SET reply_target = ? WHERE conversation_id = ?").run(handle ?? null, conversationId);
}

/**
 * Read the pointer and clear it in one go, so it is used for exactly one message. A reply pinned
 * under the wrong message a turn later would be worse than one that was never pinned.
 */
export function takeReplyTarget(conversationId) {
  const row = db.prepare("SELECT reply_target FROM threads WHERE conversation_id = ?").get(conversationId);
  if (!row?.reply_target) return null;
  setReplyTarget(conversationId, null);
  return row.reply_target;
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
export function claimInbound({ channel, externalId, conversationId, text = null }) {
  try {
    db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at, text) VALUES (?, ?, ?, ?, ?)")
      .run(channel, externalId, conversationId, clock.now(), text ? String(text) : null);
    return true;
  } catch (e) {
    if (/UNIQUE/i.test(e?.message ?? "")) return false;
    throw e;
  }
}

/**
 * Write down one part of an inbound message, so a part delivered later can be read against it.
 *
 * Last write wins on the same (channel, handle, part): a redelivery is the same part, and keeping
 * one row means this table cannot grow with a provider's retries.
 */
export function rememberInboundPart({ channel, baseHandle, partIndex, conversationId, text = "", urls = [], attachments = [] }) {
  db.prepare(`INSERT INTO inbound_parts (channel, base_handle, part_index, conversation_id, text, urls, attachments, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel, base_handle, part_index) DO UPDATE SET
      conversation_id = excluded.conversation_id, text = excluded.text,
      urls = excluded.urls, attachments = excluded.attachments, at = excluded.at`)
    .run(channel, baseHandle, partIndex, conversationId, text, JSON.stringify(urls), JSON.stringify(attachments), clock.now());
}

/** One part, with its JSON columns already parsed, or null when it was never seen. */
export function getInboundPart({ channel, baseHandle, partIndex }) {
  const r = db.prepare("SELECT * FROM inbound_parts WHERE channel = ? AND base_handle = ? AND part_index = ?")
    .get(channel, baseHandle, partIndex);
  if (!r) return null;
  return { ...r, urls: safeJson(r.urls, []), attachments: safeJson(r.attachments, []) };
}

/** Every part of one message, in the order the parts are numbered. */
export function inboundPartsOf({ channel, baseHandle }) {
  return db.prepare("SELECT * FROM inbound_parts WHERE channel = ? AND base_handle = ? ORDER BY part_index")
    .all(channel, baseHandle)
    .map(r => ({ ...r, urls: safeJson(r.urls, []), attachments: safeJson(r.attachments, []) }));
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ---------- messages waiting to see whether more of the thought is coming ----------

/**
 * Hold one message, and say when the turn for this conversation may run.
 *
 * Each new message restarts the quiet window for everything already held, which is what makes a
 * burst one turn — but never past the deadline the FIRST message of the burst set, so somebody
 * typing continuously still gets answered. Returns the window that is now in force.
 */
export function holdInbound({ conversationId, channel, address, chatId = null, externalId, text, attachments = [], service = null, isOperator = false, quietMs, maxMs, now = clock.now() }) {
  const open = db.prepare("SELECT MIN(arrived_at) AS first FROM pending_inbound WHERE conversation_id = ?").get(conversationId);
  const firstArrival = open?.first ?? now;
  const deadlineAt = firstArrival + maxMs;
  const readyAt = Math.min(now + quietMs, deadlineAt);

  db.prepare(`INSERT INTO pending_inbound
      (conversation_id, channel, address, chat_id, external_id, text, attachments, service, is_operator, arrived_at, ready_at, deadline_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, channel, address, chatId, externalId, text, JSON.stringify(attachments), service, isOperator ? 1 : 0, now, readyAt, deadlineAt);
  // Everything held for this conversation now shares one window, so "is it due" is one comparison
  // wherever it is asked from — the waiting request, the sweep, or /health.
  db.prepare("UPDATE pending_inbound SET ready_at = ?, deadline_at = ? WHERE conversation_id = ?")
    .run(readyAt, deadlineAt, conversationId);
  return { readyAt, deadlineAt, held: countPendingInbound(conversationId) };
}

/** When this conversation's held messages may run, or null when it is holding none. */
export function pendingReadyAt(conversationId) {
  const r = db.prepare("SELECT MIN(ready_at) AS at FROM pending_inbound WHERE conversation_id = ?").get(conversationId);
  return r?.at ?? null;
}

export function countPendingInbound(conversationId) {
  return db.prepare("SELECT COUNT(*) AS n FROM pending_inbound WHERE conversation_id = ?").get(conversationId).n;
}

/** Every conversation whose window has elapsed. The sweep's list, and a restart's recovery. */
export function dueConversations(now = clock.now()) {
  return db.prepare("SELECT DISTINCT conversation_id FROM pending_inbound WHERE ready_at <= ? ORDER BY conversation_id").all(now)
    .map(r => r.conversation_id);
}

/**
 * Claim everything this conversation is holding, in the order it arrived, and remove it.
 *
 * Read and delete with no `await` between them, so two overlapping drains cannot both take the same
 * messages: the second one finds nothing and does nothing. That is the whole of the locking, and it
 * holds because this driver is synchronous — a comment rather than a mutex on purpose.
 */
export function takePendingInbound(conversationId) {
  const rows = db.prepare("SELECT * FROM pending_inbound WHERE conversation_id = ? ORDER BY arrived_at, id").all(conversationId);
  if (!rows.length) return [];
  db.prepare("DELETE FROM pending_inbound WHERE conversation_id = ?").run(conversationId);
  return rows.map(r => ({ ...r, attachments: safeJson(r.attachments, []) }));
}

/** What is waiting right now, for /health. */
export function pendingInboundSummary(now = clock.now()) {
  return db.prepare(`SELECT conversation_id, COUNT(*) AS messages, MIN(ready_at) AS ready_at, MIN(deadline_at) AS deadline_at
    FROM pending_inbound GROUP BY conversation_id ORDER BY ready_at`).all()
    .map(r => ({ ...r, due: r.ready_at <= now }));
}

// ---------- what a provider has already refused ----------

/**
 * Remember that this provider will not do this, for this line or this contact.
 *
 * Written once and left alone: the second refusal of the same thing is the same fact, and keeping
 * the first `learned_at` means the log can say how long it has been true.
 */
export function recordChannelLimit({ channel, feature, scope, why = "", code = null }) {
  db.prepare(`INSERT INTO channel_limits (channel, feature, scope, why, code, learned_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(channel, feature, scope) DO NOTHING`)
    .run(channel, feature, scope, String(why), code === null ? null : String(code), clock.now());
  return channelLimit({ channel, feature, scope });
}

/** The remembered refusal, or null when this has never been refused. */
export function channelLimit({ channel, feature, scope }) {
  return db.prepare("SELECT * FROM channel_limits WHERE channel = ? AND feature = ? AND scope = ?")
    .get(channel, feature, scope) ?? null;
}

/**
 * The first refusal that applies here, line before contact.
 *
 * Line first because it is the broader fact: a line that cannot do read receipts at all makes the
 * question of whether one particular contact is verified beside the point.
 */
export function blockedFeature({ channel, feature, line = null, contact = null }) {
  for (const scope of [line ? `line:${line}` : null, contact ? `contact:${contact}` : null]) {
    if (!scope) continue;
    const hit = channelLimit({ channel, feature, scope });
    if (hit) return hit;
  }
  return null;
}

/** For /health and for the capabilities tool: what this install has learned it cannot do. */
export function listChannelLimits() {
  return db.prepare("SELECT * FROM channel_limits ORDER BY learned_at ASC").all();
}

// ---------- the outbox ----------
//
// Nothing in here decides whether to retry or what to say — that is src/outbox.js, which owns the
// policy, and src/channels/sendblue.js, which owns what Sendblue's errors mean. This is only the
// rows, so the state machine is provable without a channel.

function rowToOut(r) {
  if (!r) return null;
  return { ...r, media: r.media ? JSON.parse(r.media) : null, to_owner: !!r.to_owner };
}

/**
 * Put one message in the outbox, or find the row that is already there.
 *
 * Returning the existing row on a repeated `idemKey` rather than throwing is the whole point: a
 * caller that retries its own call — a sweep running twice, a task re-doing a step — must not be
 * able to produce a second text. `fresh` says which happened, so the caller can tell "queued" from
 * "you already asked me to send that".
 */
export function enqueueOutbound({ idemKey, conversationId, channel, address, chatId = null, body, media = null, sendStyle = null, replyTo = null, toOwner = false, maxAttempts = 5 }) {
  const existing = db.prepare("SELECT * FROM outbox WHERE idem_key = ?").get(idemKey);
  if (existing) return { fresh: false, row: rowToOut(existing) };
  const now = clock.now();
  const r = db.prepare(`INSERT INTO outbox
    (idem_key, conversation_id, channel, address, chat_id, body, media, send_style, reply_to, state, max_attempts, next_attempt_at, to_owner, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
    .run(idemKey, conversationId, channel, address, chatId, String(body ?? ""),
      media ? JSON.stringify(media) : null, sendStyle, replyTo, maxAttempts, now, toOwner ? 1 : 0, now, now);
  return { fresh: true, row: rowToOut(db.prepare("SELECT * FROM outbox WHERE id = ?").get(r.lastInsertRowid)) };
}

export function getOutbound(id) {
  return rowToOut(db.prepare("SELECT * FROM outbox WHERE id = ?").get(id));
}

/**
 * Claim one row for an attempt: `queued` → `sending`, attempts + 1.
 *
 * The compare-and-set in the WHERE clause is what makes two overlapping sweeps safe — only one of
 * them changes a row, and the loser gets `false` and moves on. `next_attempt_at` is cleared so a
 * row that is in flight is not also due.
 */
export function claimOutbound(id) {
  const now = clock.now();
  const r = db.prepare(`UPDATE outbox
    SET state = 'sending', attempts = attempts + 1, next_attempt_at = NULL, updated_at = ?
    WHERE id = ? AND state = 'queued'`).run(now, id);
  return r.changes === 1 ? getOutbound(id) : null;
}

/** It went. */
export function markOutboundSent(id, { messageId = null } = {}) {
  const now = clock.now();
  db.prepare(`UPDATE outbox SET state = 'sent', message_id = ?, sent_at = ?, next_attempt_at = NULL,
    last_error = '', updated_at = ? WHERE id = ?`).run(messageId, now, now, id);
  return getOutbound(id);
}

/** It did not go, and it might later. */
export function markOutboundRetry(id, { error, errorKey = null, errorCode = null, nextAt }) {
  const now = clock.now();
  db.prepare(`UPDATE outbox SET state = 'queued', next_attempt_at = ?, last_error = ?,
    last_error_key = ?, last_error_code = ?, updated_at = ? WHERE id = ?`)
    .run(nextAt, String(error ?? ""), errorKey, errorCode === null ? null : String(errorCode), now, id);
  return getOutbound(id);
}

/** It is never going. */
export function markOutboundFailed(id, { error, errorKey = null, errorCode = null }) {
  const now = clock.now();
  db.prepare(`UPDATE outbox SET state = 'failed', next_attempt_at = NULL, failed_at = ?,
    last_error = ?, last_error_key = ?, last_error_code = ?, updated_at = ? WHERE id = ?`)
    .run(now, String(error ?? ""), errorKey, errorCode === null ? null : String(errorCode), now, id);
  return getOutbound(id);
}

/** Nobody knows whether it arrived. Set only by the restart sweep. */
export function markOutboundUnknown(id, { error = "", nextAt = null } = {}) {
  const now = clock.now();
  db.prepare(`UPDATE outbox SET state = 'unknown', next_attempt_at = ?, last_error = ?, updated_at = ?
    WHERE id = ?`).run(nextAt, String(error ?? ""), now, id);
  return getOutbound(id);
}

/** Rows wanting an attempt now: queued ones that are due, and interrupted ones wanting a question. */
export function dueOutbound(now = clock.now(), { limit = 50 } = {}) {
  return db.prepare(`SELECT * FROM outbox
    WHERE state IN ('queued','unknown') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY id ASC LIMIT ?`).all(now, limit).map(rowToOut);
}

/**
 * Rows that were mid-flight when the last process stopped.
 *
 * Called once on startup, before any sweep. `sending` can only mean a crash: nothing else leaves a
 * row in it, because every finished attempt moves it on in the same tick.
 */
export function strandedOutbound() {
  return db.prepare("SELECT * FROM outbox WHERE state = 'sending' ORDER BY id ASC").all().map(rowToOut);
}

/**
 * Messages to this conversation that never arrived and that Reason has not been told about yet.
 *
 * Read at the top of a turn. The order is oldest first, because if two replies were lost the
 * person is owed both in the order they were meant to arrive.
 */
export function undeliveredFor(conversationId) {
  return db.prepare(`SELECT * FROM outbox WHERE conversation_id = ? AND state = 'failed' AND told_at IS NULL
    ORDER BY id ASC`).all(conversationId).map(rowToOut);
}

/** Said once. Returns false when somebody else got there first. */
export function markUndeliveredTold(id) {
  const r = db.prepare("UPDATE outbox SET told_at = ?, updated_at = ? WHERE id = ? AND told_at IS NULL")
    .run(clock.now(), clock.now(), id);
  return r.changes === 1;
}

/**
 * Failures the account owner still has to hear about: a message to somebody who is NOT them.
 *
 * This is the half that is easy to forget. Reason told them it would text Kofi; Kofi's text did
 * not go; the person who needs to know that is the owner, in their own thread, not Kofi.
 */
export function ownerUntoldFailures() {
  return db.prepare(`SELECT * FROM outbox WHERE state = 'failed' AND to_owner = 0 AND owner_told_at IS NULL
    ORDER BY id ASC`).all().map(rowToOut);
}

/** Said once. Returns false when somebody else got there first. */
export function markOwnerTold(id) {
  const r = db.prepare("UPDATE outbox SET owner_told_at = ?, updated_at = ? WHERE id = ? AND owner_told_at IS NULL")
    .run(clock.now(), clock.now(), id);
  return r.changes === 1;
}

/** For /health and for a test that wants to see the whole state machine at once. */
export function outboxCounts() {
  const rows = db.prepare("SELECT state, COUNT(*) AS n FROM outbox GROUP BY state").all();
  return Object.fromEntries(rows.map(r => [r.state, r.n]));
}

// ---------- calls ----------
/**
 * How many characters of a call's own webhook address are secret. Thirty-two of the page alphabet
 * is about 190 bits; unlike a page link this is never texted to anybody, so it is sized to be
 * unguessable rather than to fit in a bubble.
 */
export const CALL_WEBHOOK_TOKEN_LENGTH = 32;

export function createCall(conversationId, { provider, toNumber, isOwner, goal, facts, confirmationId = null, announcement = "" }) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO calls
    (conversation_id, provider, to_number, is_owner, goal, facts, state, confirmation_id,
     announcement, webhook_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'placing', ?, ?, ?, ?, ?)`)
    .run(conversationId, provider, toNumber, isOwner ? 1 : 0, goal, JSON.stringify(facts ?? []), confirmationId,
         announcement, linkToken(CALL_WEBHOOK_TOKEN_LENGTH), now, now);
  return getCall(conversationId, Number(r.lastInsertRowid));
}

/**
 * The call one webhook delivery is about. Looked up across every conversation, because the token IS
 * the claim: whoever has it was handed it when that one call was placed, and nothing in the
 * delivery's body is trusted to say which call it belongs to.
 */
export function callByWebhookToken(token) {
  const t = String(token ?? "");
  if (!t) return null;
  const r = db.prepare("SELECT * FROM calls WHERE webhook_token = ?").get(t);
  return r ? { ...r, facts: JSON.parse(r.facts) } : null;
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

// ---------- pages ----------
// Both halves of a link are letters and digits only. A link gets texted, and a text bubble is narrow:
// the long form wrapped over three lines, and a link ending in - or _ can lose that last character
// to whatever decides where a link stops.
const LINK_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function linkToken(length) {
  let out = "";
  while (out.length < length) {
    // 248 is the largest multiple of 62 a byte can hold; anything above it would favour the first
    // few letters, so it is thrown away rather than folded in.
    for (const b of randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out += LINK_ALPHABET[b % 62];
    }
  }
  return out;
}

// An id has to be unguessable: for a private page the link is half the secret, and for a shared
// one it is all of it. Ten characters is about 59 bits, and the only way to try one is a request
// to this server - short enough to text, far too many to walk.
export const PAGE_ID_LENGTH = 10;
function pageId() {
  return linkToken(PAGE_ID_LENGTH);
}

// What makes the owner's link the owner's: a second secret that rides in the link Reason texts
// them and in no other link. The shared link is the bare id and never carries it. Twelve
// characters, about 71 bits, because this one stands alone once the id has been shared.
export const PAGE_KEY_LENGTH = 12;
function pageKey() {
  return linkToken(PAGE_KEY_LENGTH);
}

export function createPage(conversationId, { title, blocks }) {
  const now = clock.now();
  const id = pageId();
  db.prepare(`INSERT INTO pages (id, conversation_id, title, content, shared, revision, created_at, updated_at, owner_key)
    VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`)
    .run(id, conversationId, title, JSON.stringify(blocks), now, now, pageKey());
  return getPage(id);
}

function rowToPage(r) {
  if (!r) return null;
  // A page from before keys existed gets one the first time it is read, so its owner's link opens
  // on a tap like every other.
  if (!r.owner_key) {
    r.owner_key = pageKey();
    db.prepare("UPDATE pages SET owner_key = ? WHERE id = ? AND owner_key IS NULL").run(r.owner_key, r.id);
  }
  return { ...r, blocks: JSON.parse(r.content), shared: !!r.shared };
}

/** By id, from anywhere — the HTTP route has an id and no conversation. */
export function getPage(id) {
  return rowToPage(db.prepare("SELECT * FROM pages WHERE id = ?").get(id));
}

/** By id, scoped — a tool may only touch a page in its own conversation. */
export function getPageIn(conversationId, id) {
  return rowToPage(db.prepare("SELECT * FROM pages WHERE id = ? AND conversation_id = ?").get(id, conversationId));
}

export function listPages(conversationId) {
  return db.prepare("SELECT * FROM pages WHERE conversation_id = ? ORDER BY updated_at DESC").all(conversationId).map(rowToPage);
}

/** Same id, same link, one more revision. That is the whole point of update. */
export function updatePage(conversationId, id, { title, blocks }) {
  const page = getPageIn(conversationId, id);
  if (!page) return null;
  db.prepare("UPDATE pages SET title = ?, content = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
    .run(title ?? page.title, JSON.stringify(blocks ?? page.blocks), clock.now(), id);
  return getPage(id);
}

export function setPageShared(conversationId, id, shared) {
  const page = getPageIn(conversationId, id);
  if (!page) return null;
  db.prepare("UPDATE pages SET shared = ?, updated_at = ? WHERE id = ?").run(shared ? 1 : 0, clock.now(), id);
  return getPage(id);
}

/** Gone, with everything hanging off it: the signed-in browsers, the codes, the picks. */
export function deletePage(conversationId, id) {
  const page = getPageIn(conversationId, id);
  if (!page) return null;
  for (const t of ["page_sessions", "page_codes", "page_attempts", "page_choices"]) {
    db.prepare(`DELETE FROM ${t} WHERE page_id = ?`).run(id);
  }
  db.prepare("DELETE FROM pages WHERE id = ?").run(id);
  return page;
}

// ---------- page access: codes, signed-in browsers, rate limit ----------
export function createPageCode(pageId_, { code, ttlMs }) {
  const now = clock.now();
  // One live code at a time: asking for a new one should not leave the old one usable.
  db.prepare("UPDATE page_codes SET expires_at = ? WHERE page_id = ? AND used_at IS NULL AND expires_at > ?")
    .run(now, pageId_, now);
  const r = db.prepare("INSERT INTO page_codes (page_id, code, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(pageId_, code, now, now + ttlMs);
  return { id: Number(r.lastInsertRowid), code, expires_at: now + ttlMs };
}

export function livePageCode(pageId_) {
  return db.prepare("SELECT * FROM page_codes WHERE page_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1")
    .get(pageId_, clock.now()) ?? null;
}

export function usePageCode(id) {
  db.prepare("UPDATE page_codes SET used_at = ? WHERE id = ?").run(clock.now(), id);
}

export function recordPageAttempt(pageId_, ok) {
  db.prepare("INSERT INTO page_attempts (page_id, at, ok) VALUES (?, ?, ?)").run(pageId_, clock.now(), ok ? 1 : 0);
}

/** How many wrong codes this page has had in the window. The rate limit reads this, not memory. */
export function failedPageAttempts(pageId_, windowMs) {
  return db.prepare("SELECT COUNT(*) AS n FROM page_attempts WHERE page_id = ? AND ok = 0 AND at >= ?")
    .get(pageId_, clock.now() - windowMs).n;
}

export function startPageSession(pageId_, token) {
  const now = clock.now();
  db.prepare("INSERT INTO page_sessions (token, page_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .run(token, pageId_, now, now);
  return token;
}

/** Is this browser signed in to this page? Touches last_seen so an idle session can be aged out. */
export function pageSessionValid(pageId_, token, maxAgeMs) {
  if (!token) return false;
  const row = db.prepare("SELECT * FROM page_sessions WHERE token = ? AND page_id = ?").get(token, pageId_);
  if (!row) return false;
  if (clock.now() - row.created_at > maxAgeMs) {
    db.prepare("DELETE FROM page_sessions WHERE token = ?").run(token);
    return false;
  }
  db.prepare("UPDATE page_sessions SET last_seen_at = ? WHERE token = ?").run(clock.now(), token);
  return true;
}

// ---------- page choices ----------
export function recordPageChoice(pageId_, { conversationId, blockKey, question, picked }) {
  const r = db.prepare(`INSERT INTO page_choices (page_id, conversation_id, block_key, question, picked, at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(pageId_, conversationId, blockKey, question ?? "", picked, clock.now());
  return { id: Number(r.lastInsertRowid) };
}

/** Picks that have not reached Reason yet. */
export function undeliveredPageChoices() {
  return db.prepare("SELECT * FROM page_choices WHERE delivered_at IS NULL ORDER BY id ASC").all();
}

/** Claimed before the turn runs, so a pick becomes exactly one event turn even if a sweep overlaps. */
export function markPageChoiceDelivered(id) {
  return db.prepare("UPDATE page_choices SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL")
    .run(clock.now(), id).changes === 1;
}

/** The latest pick per choice key, for rendering the page with the answer already on it. */
export function pageChoicesFor(pageId_) {
  const out = {};
  for (const r of db.prepare("SELECT block_key, picked FROM page_choices WHERE page_id = ? ORDER BY id ASC").all(pageId_)) {
    out[r.block_key] = r.picked;
  }
  return out;
}

// ---------- urls this conversation has really seen ----------
/**
 * Remember where a tool actually went. This is what makes "a picture must come from a real tool
 * result" checkable instead of a request: the page builder looks an image URL up in here, and a
 * URL the model typed from memory is not in here.
 */
export function rememberSeenUrls(conversationId, urls) {
  const stmt = db.prepare("INSERT OR IGNORE INTO seen_urls (conversation_id, url, at) VALUES (?, ?, ?)");
  const now = clock.now();
  let n = 0;
  for (const u of urls ?? []) {
    if (typeof u === "string" && u.length < 2000) { stmt.run(conversationId, u, now); n++; }
  }
  return n;
}

export function hasSeenUrl(conversationId, url) {
  return !!db.prepare("SELECT 1 FROM seen_urls WHERE conversation_id = ? AND url = ?").get(conversationId, url);
}

// ---------- research runs and their source logs ----------
/**
 * The source log is the point of all of this. An answer may cite what is in here and nothing else,
 * so these functions only ever write what a search or a fetch really returned — there is deliberately
 * no way to add a source by hand.
 */
function rowToResearch(r) {
  if (!r) return null;
  return {
    id: r.id, conversation_id: r.conversation_id, question: r.question,
    task_id: r.task_id ?? null, state: r.state,
    queries: JSON.parse(r.queries || "[]"),
    searches: r.searches, cut_short: r.cut_short || "",
    created_at: r.created_at, updated_at: r.updated_at, finished_at: r.finished_at ?? null,
  };
}

export function createResearch(conversationId, { question, queries = [], taskId = null }) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO research (conversation_id, question, task_id, queries, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(conversationId, question, taskId, JSON.stringify(queries), now, now);
  return getResearch(conversationId, Number(r.lastInsertRowid));
}

export function getResearch(conversationId, id) {
  return rowToResearch(db.prepare("SELECT * FROM research WHERE id = ? AND conversation_id = ?").get(id, conversationId));
}

/** For the sweep and the ledger, which have an id but no conversation in hand. */
export function getResearchAnywhere(id) {
  return rowToResearch(db.prepare("SELECT * FROM research WHERE id = ?").get(id));
}

export function researchForTask(taskId) {
  return rowToResearch(db.prepare("SELECT * FROM research WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(taskId));
}

export function listResearch(conversationId, { includeClosed = false, limit = 20 } = {}) {
  const sql = includeClosed
    ? "SELECT * FROM research WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT ?"
    : "SELECT * FROM research WHERE conversation_id = ? AND state = 'open' ORDER BY created_at LIMIT ?";
  return db.prepare(sql).all(conversationId, limit).map(rowToResearch);
}

export function setResearchQueries(conversationId, id, queries) {
  db.prepare("UPDATE research SET queries = ?, updated_at = ? WHERE id = ? AND conversation_id = ?")
    .run(JSON.stringify(queries ?? []), clock.now(), id, conversationId);
  return getResearch(conversationId, id);
}

export function noteResearchCut(conversationId, id, cutShort) {
  db.prepare("UPDATE research SET cut_short = ?, updated_at = ? WHERE id = ? AND conversation_id = ?")
    .run(cutShort ?? "", clock.now(), id, conversationId);
  return getResearch(conversationId, id);
}

export function finishResearch(conversationId, id, { cutShort = "" } = {}) {
  const now = clock.now();
  db.prepare("UPDATE research SET state = 'done', cut_short = ?, updated_at = ?, finished_at = ? WHERE id = ? AND conversation_id = ?")
    .run(cutShort ?? "", now, now, id, conversationId);
  return getResearch(conversationId, id);
}

/** One query that really ran. Counted on the row too, so a cap can be checked without a join. */
export function countResearchSearch(researchId, query) {
  db.prepare("INSERT INTO research_queries (research_id, query, at) VALUES (?, ?, ?)").run(researchId, query, clock.now());
  db.prepare("UPDATE research SET searches = searches + 1, updated_at = ? WHERE id = ?").run(clock.now(), researchId);
  return db.prepare("SELECT searches FROM research WHERE id = ?").get(researchId)?.searches ?? 0;
}

export function listResearchQueries(researchId) {
  return db.prepare("SELECT query, at FROM research_queries WHERE research_id = ? ORDER BY id").all(researchId);
}

/**
 * Add a source. A url can appear once per state, so the same page turning up in three searches is
 * one snippet row, and being read later adds a `read` row next to it rather than overwriting the
 * snippet — which keeps "what did you actually fetch" answerable afterwards.
 */
export function addResearchSource(researchId, { url, site, title = "", said = "", date = "", via, state, why = "" }) {
  // A page already read does not go back to being a snippet because a later search turned it up
  // again. Otherwise the model is handed the same source twice with two different texts, and the
  // weaker one is the one it is likelier to quote.
  if (state === "found" && db.prepare("SELECT 1 FROM research_sources WHERE research_id = ? AND url = ? AND state = 'read'").get(researchId, url)) {
    return false;
  }
  db.prepare(`INSERT OR IGNORE INTO research_sources
    (research_id, url, site, title, said, date, via, state, why, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(researchId, url, site, title, said, date, via, state, why, clock.now());
  // A page that has now been read is no longer only a snippet: drop the snippet row so the log has
  // one entry per source and the model is not handed the same site twice with two different texts.
  if (state === "read") {
    db.prepare("DELETE FROM research_sources WHERE research_id = ? AND url = ? AND state = 'found'").run(researchId, url);
  }
  return true;
}

export function listResearchSources(researchId) {
  return db.prepare("SELECT * FROM research_sources WHERE research_id = ? ORDER BY id").all(researchId);
}

export function countResearchSources(researchId, { state = null } = {}) {
  const row = state
    ? db.prepare("SELECT COUNT(*) n FROM research_sources WHERE research_id = ? AND state = ?").get(researchId, state)
    : db.prepare("SELECT COUNT(*) n FROM research_sources WHERE research_id = ?").get(researchId);
  return row?.n ?? 0;
}

// ---------- accounts of a video that a model was paid to produce ----------
/**
 * Watching a video and transcribing its audio both cost money per minute, so neither is done twice
 * for the same video. Keyed by the video and the tier, not by the conversation: an account of a
 * public video is not anybody's private content, and scoping it per person would mean paying again
 * for every person who sends the same link. Captions are free and never land here.
 */
export function saveVideoAccount({ videoKey, tier, url, title = "", model = "", seconds = null, text }) {
  db.prepare(`INSERT INTO video_accounts (video_key, tier, url, title, model, seconds, text, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_key, tier) DO UPDATE SET
      url = excluded.url, title = excluded.title, model = excluded.model,
      seconds = excluded.seconds, text = excluded.text, at = excluded.at`)
    .run(videoKey, tier, url, title, model, seconds, String(text ?? ""), clock.now());
  return { videoKey, tier };
}

export function getVideoAccount(videoKey, tier) {
  const r = db.prepare("SELECT * FROM video_accounts WHERE video_key = ? AND tier = ?").get(videoKey, tier);
  if (!r) return null;
  return { videoKey: r.video_key, tier: r.tier, url: r.url, title: r.title, model: r.model, seconds: r.seconds, text: r.text, at: r.at };
}
