// Truth of state lives here, behind tools. The model may only claim what these functions returned.
import { DatabaseSync } from "node:sqlite";
import * as secretbox from "./secretbox.js";
import * as restcrypt from "./restcrypt.js";
import * as restfiles from "./restfiles.js";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { config, clock } from "./config.js";
import * as zonescope from "./zonescope.js";
import * as turnlink from "./turnlink.js";
import { keepableMessages } from "./pagesecrets.js";
import { parseSheet, applyPatch, addSteer, emptySheet } from "./sheet.js";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
// Encryption at rest (src/restcrypt.js, REASON_ENCRYPT_REST): unlock the install key before any query,
// so every read below stays synchronous. Rows from statements on a sensitive table open themselves.
// Sealed files with no sealed rows left (a rollback cut short, flags off) still need the keystore
// unlocked to be read and opened. Only asked with the flag off: with it on the keystore opens anyway.
await restcrypt.init(config.dbPath, { hasSealed: () => restcrypt.anySealed(db.prepare.bind(db)) || (!restcrypt.flagOn() && restfiles.anySealedFile()) });
/** The unwrapped prepare: sealed values come back as stored. Migration and tests only. */
export const rawPrepare = restcrypt.wrapDatabase(db);
// With sealing on, a re-written row must not leave its old plain text in the file's free pages.
if (restcrypt.flagOn()) db.exec("PRAGMA secure_delete = ON");
/** Seal a person_facts text for the person row's owner. */
export function sealFact(personId, text) {
  if (!restcrypt.flagOn()) return text;
  const owner = db.prepare("SELECT conversation_id FROM people WHERE id = ?").get(personId)?.conversation_id;
  return restcrypt.sealFor(owner, text);
}
export { restcrypt, restfiles };
/** Seal a phase-3 column (an account's own name, card name or address); unchanged unless REASON_ENCRYPT_REST3=on. */
export const seal3 = (conversationId, text) => restcrypt.sealFor3(conversationId, text);
/**
 * Exact match on an account's own address, sealed or not: the plain value (rows from before phase 3,
 * or phase 3 off) or its blind index. `${ACCOUNT_ADDR_MATCH}` takes `accountAddrArgs(address)`.
 */
export const accountAddrMatch = (alias = "") => `(${alias}address IN (?, ?) OR ${alias}address_bi = ?)`;
export const ACCOUNT_ADDR_MATCH = accountAddrMatch();
export function accountAddrArgs(address) {
  const raw = String(address ?? "");
  return [raw, restcrypt.normalizeAddress(raw), restcrypt.addressIndexes(raw)[0] ?? null];
}
/** Seal a phase-2 column (restcrypt.SENSITIVE2) for its owner; unchanged unless REASON_ENCRYPT_REST2=on. */
export const seal2 = (conversationId, text) => restcrypt.sealFor2(conversationId, text);
/**
 * Strict mode for tables a module makes after db.js has loaded (stranger_calls, shop_shipping):
 * that module calls this once its CREATE TABLE has run.
 */
export function restStrictRefresh() {
  if (restcrypt.flagOn() && process.env.REASON_ENCRYPT_STRICT === "1") restcrypt.installStrictTriggers(db);
}

/**
 * The online migration (serve.js calls this on boot). Flag on: seal old plain rows, 200 at a time,
 * every 2 s, so a turn never waits long on it. Flag off with sealed rows left (a rollback): nothing
 * here; scripts/encrypt-rest.mjs --open writes them back as plain text.
 */
export function startRestMigration({ log = () => {}, everyMs = 2000, batch = 200 } = {}) {
  try { restfiles.sweepPlainTmp(); } catch { /* nothing left over */ }
  if (!restcrypt.flagOn() || !restcrypt.active()) return null;
  let total = 0;
  const t = setInterval(() => {
    try {
      const n = restcrypt.migrateBatch(rawPrepare, "seal", batch);
      total += n;
      if (n === 0) {
        clearInterval(t);
        log({ encrypt_rest: "migration_done", sealed: total });
        // Phase 2: the files on disk, once the rows are done (one pass; a few hundred files).
        if (restcrypt.flag2On()) restfiles.migrateFiles(rawPrepare, "seal", { log })
          .catch(e => log({ encrypt_rest: "file_migration_error", error: String(e?.message ?? e).slice(0, 200) }));
      }
    } catch (e) { clearInterval(t); log({ encrypt_rest: "migration_error", error: String(e?.message ?? e).slice(0, 200) }); }
  }, everyMs);
  t.unref?.();
  return t;
}

/**
 * How long a write waits for another connection's lock before SQLite gives up with "database is
 * locked". SQLite's default is 0: the recall backfill (scripts/recall-backfill.mjs, its own process)
 * writing beside the running server failed twice on live on 11-06 with no wait at all. Every
 * connection Reason opens sets it (scripts/call-report.js, scripts/web-migrate-dry-run.mjs too).
 */
export const BUSY_TIMEOUT_MS = 5000;

db.exec(`
  PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
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
    deadline_at INTEGER NOT NULL,
    -- How many times this text has been put back because the model was down (src/down.js), and
    -- when that outage started. A row held for a burst has 0 and NULL.
    held_times INTEGER NOT NULL DEFAULT 0,
    down_since INTEGER
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
  -- The thirty seconds between "yes" and the thing actually happening.
  --
  -- A yes is given in a second and regretted in five, and the regret has nowhere to go: the email
  -- has landed, the text is on somebody's phone, the invite is in their calendar. So anything that
  -- reaches a third party waits here first, with the words it will say and who it will reach, and
  -- one word takes it back. See src/undo.js, which owns the window and the lines.
  --
  -- The row is the whole mechanism, and it is a row rather than a setTimeout for the obvious
  -- reason: a process that restarts eleven seconds into a window must neither lose the thing nor
  -- send it twice. Both halves are here —
  --
  --   NOT LOST   'held' with a due time survives the restart; the next sweep finds it due.
  --   NOT TWICE  'held' → 'going' is a compare-and-set, so two overlapping sweeps cannot both
  --              release the same row, and a row that has left 'held' can never be stopped either.
  --              What goes on the wire is still the outbox's job: idem_key is carried into it,
  --              so even a released row somehow run twice finds the outbox row it already made
  --              rather than producing a second text.
  --
  --   held     waiting out its window. The only state 'undo' can act on.
  --   going    being carried out right now.
  --   sent     it happened. The ledger has the receipt.
  --   stopped  they said undo in time. It never happened and never will.
  --   failed   the window ran out and the thing itself did not work. last_error says why.
  --   unknown  the process stopped mid-release. NOT retried: see recoverStrandedHolds.
  CREATE TABLE IF NOT EXISTS held_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    -- The tool this will run and the input it will run with, settled before the hold starts, so
    -- the thing that happens in thirty seconds is exactly the thing they were told about.
    action TEXT NOT NULL,
    input TEXT NOT NULL,
    -- Which window length applies — text | email | calendar | call. Theirs to set per kind.
    kind TEXT NOT NULL,
    -- What it is and who it reaches, in the same words the line to them uses. Named, never
    -- "a message": a hold nobody can identify is a hold nobody can undo.
    what TEXT NOT NULL,
    to_whom TEXT NOT NULL,
    -- The whole clause — "sending the email 'Lease renewal' to marta@…" — because the preposition
    -- differs per action and "to" in front of a calendar is wrong. Written once, at the hold, so
    -- the line that says it was held, the page that shows it and the line that says it failed are
    -- all describing it in the same words.
    doing TEXT NOT NULL DEFAULT '',
    idem_key TEXT NOT NULL UNIQUE,
    hold_ms INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'held',
    -- The yes this goes out on, spent when the hold starts rather than when it lands: they said
    -- yes to the thing, and the window is the out after that, never a second question.
    confirmation_id INTEGER,
    permission_id INTEGER,
    result TEXT,
    last_error TEXT NOT NULL DEFAULT '',
    told_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    released_at INTEGER,
    stopped_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS held_due ON held_actions (state, due_at);
  CREATE INDEX IF NOT EXISTS held_thread ON held_actions (conversation_id, state);
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
  -- One request that needs several phone calls. "Find me the cheapest place that can do it tomorrow"
  -- is ONE errand and six calls, and almost everything that makes it useful is a property of the
  -- errand rather than of any one call: that they were all asked the same questions, that the answers
  -- compare, that unreached places are reported, and that AT MOST ONE of them ends in a commitment.
  CREATE TABLE IF NOT EXISTS call_errands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    goal TEXT NOT NULL,
    -- 'inquiry' asks and agrees to nothing. 'booking' may commit, once, after the owner says which.
    kind TEXT NOT NULL DEFAULT 'inquiry',
    -- The core questions, stored once here so the sixth call cannot ask a thinner version than the
    -- first — which is how a comparison quietly becomes apples and oranges.
    questions TEXT NOT NULL DEFAULT '[]',
    brief TEXT NOT NULL DEFAULT '{}',
    -- open | awaiting_owner | committing | done | given_up
    state TEXT NOT NULL DEFAULT 'open',
    decision TEXT NOT NULL DEFAULT '',
    -- The one call that was allowed to commit. The lock in src/calls/commit.js is this column being
    -- empty, which is why it is on the errand and not worked out by counting rows.
    committed_call_id INTEGER,
    task_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  -- What one place said, in a shape two places can be compared in.
  CREATE TABLE IF NOT EXISTS call_quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    errand_id INTEGER NOT NULL,
    call_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    place TEXT NOT NULL DEFAULT '',
    to_number TEXT NOT NULL DEFAULT '',
    -- Cents, never a float: two quotes that differ by a hundredth of a cent sort wrong, and the
    -- owner's "cheapest" has to mean the number they would actually be charged. total_cents is
    -- that number — price plus every fee — and it is what the comparison sorts on.
    price_cents INTEGER,
    fees_cents INTEGER,
    total_cents INTEGER,
    currency TEXT NOT NULL DEFAULT 'USD',
    -- firm | estimate | unknown. The owner's own distinction, kept as a column rather than as an
    -- adjective in a summary, because "about two hundred" and "two hundred" are different promises.
    firmness TEXT NOT NULL DEFAULT 'unknown',
    holds_until TEXT NOT NULL DEFAULT '',
    earliest TEXT NOT NULL DEFAULT '',
    included TEXT NOT NULL DEFAULT '[]',
    excluded TEXT NOT NULL DEFAULT '[]',
    -- Who said it and when, because "they told me Tuesday" is worth less three days later.
    said_by TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  -- Every time a call was about to agree to something. One row per attempt, including the ones that
  -- were stopped, because "it nearly booked that and came to me instead" is the interesting case.
  CREATE TABLE IF NOT EXISTS call_commitments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    call_id INTEGER NOT NULL,
    errand_id INTEGER,
    what TEXT NOT NULL,
    total_cents INTEGER,
    terms TEXT NOT NULL DEFAULT '[]',
    -- proposed | paused_for_owner | committed | released | declined
    --
    -- 'released' is the one that is easy to leave out and matters: a call that was asked to hold an
    -- option and is then told to let it go has to ACTUALLY let it go, politely, and the row records
    -- that it did. Otherwise the second-cheapest place is quietly still holding a slot.
    state TEXT NOT NULL DEFAULT 'proposed',
    why TEXT NOT NULL DEFAULT '',
    -- What about this was outside what the owner approved, when something was. This is what he gets
    -- texted, so it is kept rather than regenerated from a summary.
    outside TEXT NOT NULL DEFAULT '[]',
    reference TEXT NOT NULL DEFAULT '',
    readback TEXT NOT NULL DEFAULT '{}',
    asked_owner_at INTEGER,
    owner_said TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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
  -- A file a tool call of this conversation wrote (src/ownfiles.js): the proof a path given later
  -- (drive_upload, voice_note_send) is theirs and not somebody else's in the same folder.
  CREATE TABLE IF NOT EXISTS conversation_files (
    conversation_id TEXT NOT NULL,
    path TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, path)
  );
  -- A real document Reason wrote and handed over: a Word document, a slide deck, a PDF. The row is
  -- the record and the path column is the file itself, on this machine under the data directory --
  -- which is what makes "the export carries it", "a delete removes it" and "send me that again" all
  -- mean the same bytes. content is the checked block list it was built from
  -- (src/documents/content.js, never markup), kept so a resend does not have to ask the model to
  -- write the thing twice. sent_at is the moment a send really came back ok, and nothing else may
  -- be read as one.
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    closing TEXT,
    content TEXT NOT NULL,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS documents_thread ON documents (conversation_id, created_at);
  -- A browser that has proved it holds the one-time code. Per page, so a code for one page does
  -- not quietly open every other one.
  CREATE TABLE IF NOT EXISTS page_sessions (
    token TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  -- A walk Reason made (src/trips.js): the directions page at /d/<id>. trip is the page's JSON (the
  -- route, the steps, the map's shapes); streets is the named ways near it, kept only to name a
  -- reroute's steps and never sent to the page. Nothing of the walk itself is kept: a position the
  -- phone sends to find a new way is answered and dropped. The row goes at expires_at.
  CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    trip TEXT NOT NULL,
    streets TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
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
  -- Which new features each person has been told about, so nobody hears the same one twice.
  -- Keyed by conversation id, like everything else per-person, so one person's "already heard" is
  -- nobody else's. A row is CLAIMED when the model says its reply mentions the thing and only gets
  -- told_at once that reply has actually gone out — an unsent claim is dropped, which is what keeps
  -- "they have heard it" from meaning "the model meant to say it". See src/whatsnew.js.
  CREATE TABLE IF NOT EXISTS whats_new_told (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    claimed_at INTEGER NOT NULL,
    told_at INTEGER,
    UNIQUE(conversation_id, entry_id)
  );
  -- When Reason tells somebody it cannot do something because a capability is not connected or not
  -- built yet, the miss is written here. Later, when the capability goes live for that person,
  -- Reason threads their original message with a casual "hey, I can do this now." One row per miss,
  -- resolved_at marks it done so it is only said once. See src/whatsnew.js.
  CREATE TABLE IF NOT EXISTS capability_misses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    summary TEXT NOT NULL,
    message_handle TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS capability_misses_open ON capability_misses (conversation_id, resolved_at);
  -- Everything somebody sent that was not words, and what was actually got out of it.
  --
  -- Three things need this and none of them can be done from the conversation text. "This one" and
  -- "the second photo" need each item to be a thing with an identity. Several photos on one message
  -- need to be known to be ONE message's worth. And "what did you actually look at" needs an answer
  -- that is a record rather than the model's memory of a turn — a picture is in front of the model
  -- for exactly one turn and then gone, so without a row there is nothing left but a sentence it
  -- wrote about having looked.
  --
  -- One row per item, written the moment the message is claimed, before anything has processed it.
  -- 'coverage' is then moved as processing happens, and it is the honest word for what succeeded:
  --
  --   waiting      it arrived; nothing has looked at it yet
  --   looked       the picture was put in front of the model
  --   transcribed  the words in it, from audio
  --   no_speech    audio with nothing said in it
  --   captions     a video's own captions were read. Words only
  --   watched      a video model was handed it and watched it. Picture and sound
  --   heard        only a video's audio could be taken and transcribed. Words only
  --   metadata     only what the page or the video claims about itself
  --   read         a page was fetched and its text read
  --   failed       it could not be opened, and 'detail' says why, in words
  --   dropped      it was a fragment of a message already handled — a link card's preview image —
  --                and 'detail' says that. Recorded rather than forgotten precisely because that
  --                judgement is a guess (see src/parts.js): a photo wrongly eaten leaves a row.
  --
  -- 'ordinal' is 1, 2, 3 within ONE message, which is what makes "the second photo" a thing that
  -- can be pointed at. Keyed with the provider's own event id, so a redelivered webhook overwrites
  -- one row rather than growing the table.
  CREATE TABLE IF NOT EXISTS media_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    external_id TEXT NOT NULL,
    base_handle TEXT NOT NULL DEFAULT '',
    part_index INTEGER NOT NULL DEFAULT 0,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    filename TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    coverage TEXT NOT NULL DEFAULT 'waiting',
    detail TEXT NOT NULL DEFAULT '',
    bytes INTEGER,
    at INTEGER NOT NULL,
    reviewed_at INTEGER,
    UNIQUE(channel, external_id, ordinal)
  );
  CREATE INDEX IF NOT EXISTS media_items_thread ON media_items (conversation_id, id);

  -- ---------- noticing things first (src/notice.js) ----------
  --
  -- Four tables, and the split between them is the whole design: one remembers what their next two
  -- days looked like last time anybody looked, one remembers every thing that was ever worth
  -- raising and whether it was really said, one counts what a day has cost them in interruptions,
  -- and one is the high-water mark that stops the same sweep finding the same news twice.

  -- What their calendar said at the last sweep. The ONLY reason this exists is that "your 2pm with
  -- Dana moved to 3" cannot be read off a calendar — it needs the 2pm. So this is a snapshot of the
  -- next couple of days per account, and the diff against the live read is what "moved", "cancelled",
  -- "new" and "somebody new is on it" actually mean. It holds their event titles, so a retention
  -- sweep reaches it like any other content.
  CREATE TABLE IF NOT EXISTS notice_events (
    conversation_id TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    event_id TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    start TEXT NOT NULL DEFAULT '',
    end_at TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    attendees TEXT NOT NULL DEFAULT '[]',
    time_zone TEXT NOT NULL DEFAULT '',
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, account, event_id)
  );

  -- Every candidate the sweep has ever raised, once. 'key' is the identity of the thing AND of its
  -- state — an event id with the time it moved to, a thread id with the hour it has been waiting —
  -- so the same meeting moving twice is two candidates and the same meeting found on six sweeps is
  -- one. That is what "nothing is seen twice" means here, and it is a UNIQUE constraint rather than
  -- a rule the model is asked to keep.
  --
  -- The three timestamps are three different facts and must not be collapsed:
  --   claimed_at  the model called notice_send and the turn is still running. Not told yet.
  --   said_at     the text really went out. Only then does it count against the budget, and only
  --               then is the key spent. A claim on a turn that sent nothing is released.
  --   held_at     a sweep wanted to raise this and code would not let it — budget spent, quiet
  --               hours, or a moment that has not come. Still true, so it goes first next time and
  --               folds into the next reply they are already reading.
  CREATE TABLE IF NOT EXISTS notice_seen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    what TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    -- When this is worth saying, in real time: 2h before the thing, or now. Code's, not the model's.
    moment_at INTEGER,
    -- The one-off timer scheduled for that moment, when it is further off than the next sweep.
    timer_id INTEGER,
    first_seen INTEGER NOT NULL,
    claimed_at INTEGER,
    said_at INTEGER,
    held_at INTEGER,
    holds INTEGER NOT NULL DEFAULT 0,
    urgent INTEGER NOT NULL DEFAULT 0,
    why_now TEXT NOT NULL DEFAULT '',
    UNIQUE(conversation_id, kind, key)
  );
  CREATE INDEX IF NOT EXISTS notice_seen_thread ON notice_seen (conversation_id, said_at);

  -- One unprompted catch a day, counted here rather than guessed. Keyed by the LOCAL day in their
  -- own zone, which is what "resets at midnight" means without a job that has to run at midnight.
  CREATE TABLE IF NOT EXISTS notice_budget (
    conversation_id TEXT NOT NULL,
    day TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    urgent INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, day)
  );

  -- Where each person's sweep got to. 'last_at' is the window everything is read from, so a process
  -- that was down for a day reads a day of mail rather than two hours of it, and 'last_follow_on_at'
  -- is the same mark for "what did finishing that set in motion".
  CREATE TABLE IF NOT EXISTS notice_sweeps (
    conversation_id TEXT PRIMARY KEY,
    last_at INTEGER,
    last_follow_on_at INTEGER,
    runs INTEGER NOT NULL DEFAULT 0,
    time_zone TEXT NOT NULL DEFAULT ''
  );

  -- Named places a person has told you about: home, work, gym, a friend's house. Geocoded once
  -- when they share the address, then used by the notice sweep to compute travel time. A place
  -- with an arrive_by time generates a daily "leave by" candidate on the days it applies.
  --
  -- arrive_by is minutes since midnight in THEIR zone (e.g. 540 = 9:00 AM). NULL means no daily
  -- check — used for home, which is the departure point rather than a destination.
  -- days is a 7-char string "MTWTFSS" where a letter means active and a dot means skip, e.g.
  -- "MTWTF.." for weekdays. NULL means every day.
  -- mode is HOW they get there: drive | transit | walk | bike. Determines whether the sweep
  -- computes live driving time (OSRM) or uses their stated travel_minutes. NULL defaults to drive.
  -- travel_minutes is what they told you it takes — "45 minutes door to door". For transit this
  -- IS the travel time (no API can beat somebody's own commute knowledge). For driving it is a
  -- stated override or sanity check; NULL means compute live each sweep.
  -- route_description is their own words about how they get there — "I take the 2 from Allerton
  -- to Chambers, then walk". Shown back to them and used by the model to give specific advice.
  CREATE TABLE IF NOT EXISTS saved_places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    address TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    arrive_by INTEGER,
    days TEXT,
    mode TEXT,
    travel_minutes INTEGER,
    route_description TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(conversation_id, name_key)
  );
  CREATE INDEX IF NOT EXISTS saved_places_conv ON saved_places (conversation_id);

  -- What this person is actually paying for every month, and where each one got to.
  --
  -- This table is the answer to "what am I paying for", and the reason it exists rather than the
  -- model remembering: a scan reads a year of receipts in one turn, and sixty messages later that
  -- turn is gone. Without a row, "did you cancel Hulu" has no answer but the model's recollection
  -- of having meant to.
  --
  -- Three columns carry the whole of the honesty here:
  --
  --   'status'       active | cancelling | cancelled | kept | unknown. 'cancelling' is the one that
  --                  matters and the one a looser design would not have had: a cancel flow that has
  --                  been walked and not confirmed is NOT cancelled, and the difference is somebody
  --                  stopping checking their bank versus somebody being charged again. The write
  --                  path refuses to set 'cancelled' with no confirmation on it.
  --   'confirmation' the proof, in the words it arrived in — a confirmation number off the page, an
  --                  "ends on" date, the subject of the confirmation email. Empty means none.
  --   'source'       what the row was read off: a Gmail message id and which account, or the
  --                  person's own words. So "where did you get $17.99" is answerable months later.
  --
  -- Keyed by (conversation, merchant_key) so a second scan updates the Netflix row rather than
  -- making a fourth one. merchant_key is the merchant lowercased and squeezed, which is what makes
  -- "Netflix", "netflix" and "NETFLIX.COM" one subscription.
  --
  -- Not swept by the retention pass, like plans and tasks and for the same reason: it is live state
  -- about somebody's money rather than a copy of something that arrived. It goes when they delete
  -- their data (npm run data:delete), which src/data.js covers.
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    merchant TEXT NOT NULL,
    merchant_key TEXT NOT NULL,
    service TEXT NOT NULL DEFAULT '',          -- the src/cancel-routes.js entry, when one matches
    amount_cents INTEGER,
    currency TEXT NOT NULL DEFAULT 'USD',
    cadence TEXT NOT NULL DEFAULT 'unknown',   -- monthly | yearly | weekly | unknown
    last_charged TEXT NOT NULL DEFAULT '',
    next_renewal TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    cancel_route TEXT NOT NULL DEFAULT 'unknown',
    cancel_url TEXT NOT NULL DEFAULT '',
    cancel_email TEXT NOT NULL DEFAULT '',
    confirmation TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    cancelled_at INTEGER,
    UNIQUE(conversation_id, merchant_key)
  );
  CREATE INDEX IF NOT EXISTS subscriptions_thread ON subscriptions (conversation_id, status);
  -- A standing check-in: "every monday, about the job search". ONE row for the whole arrangement,
  -- and every firing is an ordinary timers row pointing back at it through series_id, so the fire
  -- path, the retry rules, the kept note and everything else that already reads timers keep working
  -- with no idea this table exists. See src/series.js, which owns the maths.
  --
  -- rule is JSON: { kind: daily|weekdays|weekly|every_n_days|monthly, hour, minute, weekdays?,
  -- day_of_month?, n?, anchor?, their_time? }. tz is the person's zone at the moment they asked,
  -- resolved the way everything else resolves it (their stated zone, then their calendar's, then the
  -- install's), and it is stored rather than looked up again so a series set in New York keeps firing
  -- at nine in New York.
  --
  -- next_at is the next occurrence NOT YET SCHEDULED, and it moves when a timer is made rather than
  -- when one fires. That is what makes the sweep idempotent: a firing somebody cancelled is skipped
  -- instead of being made again, and two overlapping sweeps cannot both schedule the same occurrence.
  --
  -- last_report is what they said back the last time it asked, kept so the next check-in can
  -- reference it instead of repeating itself. awaiting_since is set when a check-in really goes out
  -- and is what makes the next thing they say their answer to it.
  --
  -- Not swept by the retention pass while it is active, like plans and tasks: it is live state about
  -- a standing arrangement rather than a copy of something that arrived. The words in last_report
  -- ARE content and do go on the content window; an ended series goes on the records one. See
  -- src/privacy.js.
  CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    what TEXT NOT NULL,
    rule TEXT NOT NULL,
    tz TEXT NOT NULL,
    next_at INTEGER,
    last_fired_at INTEGER,
    fired_count INTEGER NOT NULL DEFAULT 0,
    last_report TEXT,
    last_report_at INTEGER,
    awaiting_since INTEGER,
    state TEXT NOT NULL DEFAULT 'active',      -- active | paused | ended
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_why TEXT
  );
  CREATE INDEX IF NOT EXISTS series_thread ON series (conversation_id, state);

  -- ---------- a standing commitment, and whether they showed up (src/commitment.js) ----------
  --
  -- Two tables, and the split is the same one the rest of this file keeps: one holds what they SAID
  -- they would do, one holds what actually happened. Nothing in either is a judgement about them.
  --
  -- The thing they said: "leg day tuesdays and fridays 7am". 'days' is a JSON array of 0-6 with
  -- Sunday as 0, 'at_min' is minutes after midnight, and 'time_zone' is stamped HERE, at save time,
  -- because a schedule saved in the install's zone is how a past release shipped Eastern timers to
  -- everybody (see src/notice.js on the same subject). A commitment's own zone travels with it.
  --
  -- 'said' is their sentence, word for word, and the row rests on it: a commitment is only ever
  -- something they told Reason, never something it worked out from a calendar or a refill mail.
  -- 'state' is active | paused | ended, so "stop nudging me about it" and "I'm done with it" are
  -- two different answers and both are honoured without deleting what they logged.
  --
  -- Keyed by (conversation, key) — the thing lowercased and squeezed — so saying "leg day tuesdays
  -- and fridays 7am" twice updates one row instead of making a second leg day.
  CREATE TABLE IF NOT EXISTS commitments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    what TEXT NOT NULL,
    key TEXT NOT NULL,
    days TEXT NOT NULL DEFAULT '[]',
    at_min INTEGER NOT NULL,
    time_zone TEXT NOT NULL,
    grace_min INTEGER NOT NULL DEFAULT 10,
    said TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_why TEXT NOT NULL DEFAULT '',
    UNIQUE(conversation_id, key)
  );
  CREATE INDEX IF NOT EXISTS commitments_thread ON commitments (conversation_id, state);

  -- What really happened, one row per occurrence. UNIQUE(commitment_id, day) is what makes "I
  -- already went" and the 7:10 nudge the same fact rather than two: the nudge pass looks for a row
  -- on today's local day, and a row of any kind means there is nothing to notice.
  --
  --   'kind'   went     they did it. The only kind that counts as showing up.
  --            missed   they said they are not going. Accepted, logged, never re-asked.
  --            hurt     they said something hurts. Logged as not going, and it is the one kind that
  --                     suppresses the plan outright: no lifts, no numbers, no push, no advice.
  --            moved    they moved this one occurrence. 'at_min' carries the new time for this day
  --                     only, and the grace clock restarts from it.
  --
  -- 'items' is the session as they reported it — a JSON array of {what, weight, sets, reps} — and it
  -- is the ONLY source for anything Reason ever says about a number they lifted. An empty array is
  -- the honest state for a plain "went", and a progression line with no row behind it is refused by
  -- having nothing to read.
  --
  -- 'said' is their words. Live state about their own week, like a plan or a task, so the retention
  -- sweep does not reach it; a full delete takes it (src/data.js).
  CREATE TABLE IF NOT EXISTS commitment_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    commitment_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    items TEXT NOT NULL DEFAULT '[]',
    at_min INTEGER,
    said TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL,
    UNIQUE(commitment_id, day)
  );
  CREATE INDEX IF NOT EXISTS commitment_logs_thread ON commitment_logs (conversation_id, at);

  -- A flight somebody is on, so Reason can watch the AIRLINE rather than their inbox.
  --
  -- Three columns carry the time, and keeping them as three is the whole point:
  --
  --   'departs_local'  the FLIGHT's own wall clock, '2026-10-09T07:15:00'. No offset on it.
  --   'time_zone'      the IANA zone the departure airport is in, stamped when the row is saved.
  --   'departs_at'     the real instant, worked out from those two at save time.
  --
  -- A single epoch column would have been enough to store it and useless to say out loud: "your
  -- 7:15am" has to come off the wall clock, because formatting the instant in whatever zone this
  -- machine happens to be in is exactly how a check-in offer arrives five hours late for somebody
  -- flying out of London. And a single wall-clock column would have been useless to schedule from.
  -- So both, plus the zone that ties them together, computed once rather than guessed at twice.
  --
  -- 'checkin_opens_at' is derived from the airline's own window (src/airlines.js, 24h by default) and
  -- stored, so the sweep is a cheap comparison rather than a registry lookup per flight per pass.
  --
  -- 'guessed' is a JSON array of the field names Reason worked out rather than was told — the
  -- src/memory.js pattern, where a guess is kept, labelled, and never stated back as fact. A year
  -- guessed off "friday" is in there; a confirmation code somebody typed is not.
  --
  -- 'status' booked | offered | checking_in | checked_in | needs_them | missed | cancelled.
  -- 'needs_them' is the honest-path state: it got somewhere, could not finish, and handed back the
  -- furthest point. 'checked_in' is only ever written after the airline's own page was read and said
  -- so (src/flights.js verifyCheckIn) — never off a 200.
  --
  -- Keyed by (conversation, flight_key) so the same flight told twice is one row.
  --
  -- Not swept by the retention pass, like plans, tasks and subscriptions: it is live state about
  -- something that is going to happen, not a copy of something that arrived. It goes when they
  -- delete their data (npm run data:delete), which src/data.js covers.
  CREATE TABLE IF NOT EXISTS flights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    flight_key TEXT NOT NULL,
    airline TEXT NOT NULL,                     -- as they said it: "Delta"
    airline_key TEXT NOT NULL DEFAULT '',      -- the src/airlines.js entry, when one matches
    flight_number TEXT NOT NULL DEFAULT '',
    confirmation_code TEXT NOT NULL DEFAULT '',
    passenger_name TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT '',           -- airport code, when known
    origin_name TEXT NOT NULL DEFAULT '',
    destination TEXT NOT NULL DEFAULT '',
    destination_name TEXT NOT NULL DEFAULT '',
    departs_local TEXT NOT NULL,
    time_zone TEXT NOT NULL,
    departs_at INTEGER NOT NULL,
    checkin_opens_at INTEGER,
    checkin_window_hours INTEGER,
    seat_preference TEXT NOT NULL DEFAULT '',  -- their words: "aisle if u can"
    seat TEXT NOT NULL DEFAULT '',             -- what the airline gave, read off its page
    boarding_position TEXT NOT NULL DEFAULT '',-- Southwest and anyone else without assigned seats
    status TEXT NOT NULL DEFAULT 'booked',
    guessed TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT '',           -- 'they told me' | 'gmail <id> in <account>' | 'calendar <id>'
    page_id TEXT NOT NULL DEFAULT '',          -- the boarding-pass page, once there is one
    shot_path TEXT NOT NULL DEFAULT '',        -- the screenshot of the checked-in screen
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    checked_in_at INTEGER,
    UNIQUE(conversation_id, flight_key)
  );
  CREATE INDEX IF NOT EXISTS flights_due ON flights (status, checkin_opens_at);
  CREATE INDEX IF NOT EXISTS flights_thread ON flights (conversation_id, departs_at);

  -- ---------- something they are trying to do, and the standing help offered for it ----------
  --
  -- "I'm job searching." "Trying to find an apartment." A goal is bigger than a task and smaller
  -- than a life: it lasts weeks, it has criteria, and the useful thing to do about one is to offer
  -- to keep looking rather than to answer once. See src/goals.js, which owns every rule.
  --
  -- Four columns carry the whole of the manners here, and they are the reason this is a table and
  -- not something the model remembers:
  --
  --   'state'        noticed | offered | declined | running | paused | done | dropped. 'declined'
  --                  is the one that matters and the one a looser design would not have kept: an
  --                  offer they turned down must never be pitched again, and sixty messages later
  --                  the turn that was told no is long gone from the thread.
  --   'offers'       how many times the standing help has been pitched. The write path refuses a
  --                  second pitch while the first is unanswered, so "do not keep asking" is a
  --                  constraint rather than a request.
  --   'criteria'     what they actually said they want, field by field, in their words. Reused so
  --                  they are never asked the same question twice, and 'criteria_confirmed_at' is
  --                  what makes the difference between what Reason guessed and what they confirmed.
  --   'series_id'    the standing check-in doing the looking, once it is running. One goal, one
  --                  series — so pausing, changing and stopping are the machinery that already
  --                  exists rather than a second scheduler.
  --
  -- Keyed by (conversation, key) so "the apartment thing" mentioned a third time is one goal.
  --
  -- Not swept by the retention pass while it is live, like plans and commitments: it is a standing
  -- arrangement rather than a copy of something that arrived. It goes when they delete their data.
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    what TEXT NOT NULL,
    key TEXT NOT NULL,
    said TEXT NOT NULL DEFAULT '',              -- their own sentence, word for word
    help TEXT NOT NULL DEFAULT '',              -- the standing help, in Reason's words
    criteria TEXT NOT NULL DEFAULT '{}',
    criteria_confirmed_at INTEGER,
    cadence TEXT NOT NULL DEFAULT '',           -- the schedule in plain words, off the series
    delivery TEXT NOT NULL DEFAULT '',          -- how they want it: a text, a page, only the good ones
    series_id INTEGER,
    state TEXT NOT NULL DEFAULT 'noticed',
    offered_at INTEGER,
    offers INTEGER NOT NULL DEFAULT 0,
    offer_said TEXT NOT NULL DEFAULT '',        -- the line that was pitched, as it went
    declined_at INTEGER,
    declined_said TEXT NOT NULL DEFAULT '',     -- their no, word for word
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_why TEXT NOT NULL DEFAULT '',
    UNIQUE(conversation_id, key)
  );
  CREATE INDEX IF NOT EXISTS goals_thread ON goals (conversation_id, state);

  -- Everything a goal's standing search has ever turned up, once. 'match_key' is the identity of
  -- the thing itself — a listing id, a posting URL — and the UNIQUE on it is what makes "never show
  -- them the same flat twice" a constraint rather than a thing the model has to remember across
  -- weeks of trimmed history. 'sent_at' is the honest half: found is not told.
  CREATE TABLE IF NOT EXISTS goal_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    match_key TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    found_at INTEGER NOT NULL,
    sent_at INTEGER,
    UNIQUE(goal_id, match_key)
  );
  CREATE INDEX IF NOT EXISTS goal_matches_goal ON goal_matches (goal_id, found_at);

  -- Every incoming message, tracked as a potential request. The drain creates one row per held
  -- message BEFORE the turn, so the model can see them, classify them, and answer each under its
  -- own message. Rows whose kind stays 'pending' after the turn are auto-dropped.
  --
  -- kind:   pending (just arrived, unclassified), request, correction, chat
  -- status: open (unanswered), answered, dropped (chat or stale)
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    inbound_handle TEXT,
    text TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'pending',
    status TEXT NOT NULL DEFAULT 'open',
    summary TEXT NOT NULL DEFAULT '',
    corrects_id INTEGER,
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS requests_open ON requests (conversation_id, status);

  -- Which inbound texts belong to which request (src/onethought.js). A drain links each text it
  -- opened a request for ('opened'); a text that arrived mid-turn and was read as adding to the
  -- request being worked on is linked to THAT request ('continuation') and never gets one of its
  -- own — one thought, one answer. Scoped by conversation like everything else.
  CREATE TABLE IF NOT EXISTS request_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    request_id INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'opened',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS request_messages_req ON request_messages (conversation_id, request_id);

  -- Every question Reason has asked them (src/said.js), so one answered by them, answered by
  -- Reason's own later research, or made obsolete is CLOSED, and a late "yes" cannot restart
  -- finished work. status: open | closed. closed_reason: answered_by_them | answered_by_reason |
  -- obsolete | declined. A declined row is something Reason raised or offered that they turned down
  -- ("leave it, I have reasons"); it is shown for months, not hours, so it is never raised again.
  CREATE TABLE IF NOT EXISTS open_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    request_id INTEGER,
    question TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    closed_reason TEXT,
    created_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS open_questions_conv ON open_questions (conversation_id, status, created_at);

  -- The concrete values a sent message asserted — a showtime, a price, which theater is closest
  -- (src/said.js). Kept so a later message that changes one has to say so, and the old one is
  -- marked superseded rather than left standing next to the new. certain: 1 confirmed, 0 a maybe.
  -- status: standing | superseded. flagged: whether the superseding message said out loud that
  -- the value changed (0 is the failure this exists to catch).
  CREATE TABLE IF NOT EXISTS sent_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    request_id INTEGER,
    subject TEXT NOT NULL,
    value TEXT NOT NULL,
    certain INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'standing',
    superseded_by INTEGER,
    flagged INTEGER,
    created_at INTEGER NOT NULL,
    superseded_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS sent_claims_conv ON sent_claims (conversation_id, status, created_at);
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
// Which browser asked for a sign-in code (a hash; null for a page's own code gate): see createPageCode.
addColumnIfMissing("page_codes", "bound", "TEXT");
// A timer used to be marked fired BEFORE its turn ran, so a turn that died took the reminder with
// it (2026-10-06, see Runtime.tick). Now it is fired only once its message is in the outbox, and
// these are what a timer that has not got there yet carries: how many tries it has had, when the
// next one may start, what went wrong last, and — if it ran out — when Reason gave up on it.
addColumnIfMissing("timers", "attempts", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("timers", "next_try_at", "INTEGER");
addColumnIfMissing("timers", "last_error", "TEXT");
addColumnIfMissing("timers", "gave_up_at", "INTEGER");
// Which standing permission a row went through on, when it went through on one instead of on a yes
// (2026-10-06). Null on every row from before, and null on every row that was really asked about,
// which is exactly the distinction somebody auditing the ledger is looking for. The receipt says it
// in their own words as well — see ledgerWrite in src/trust.js — because the id is for joining and
// the sentence is for reading.
addColumnIfMissing("action_ledger", "permission_id", "INTEGER");
// The 2026-10-07 calls addendum. Whether the person on an OWNER call has passed the second check
// (caller ID is not proof of who is holding the phone), how, and the bookkeeping for the texted
// version of that check; and which turn profile and speech model the call ran under, so a number
// measured later says what it was measured under.
addColumnIfMissing("calls", "verified_at", "INTEGER");
addColumnIfMissing("calls", "verified_how", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "verify_tries", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("calls", "verify_sent_at", "INTEGER");
addColumnIfMissing("calls", "verify_sent_after_msgs", "INTEGER");
// What an unverified caller asked for that waits for the call to end, picked up by text after it
// (src/calls/verify.js; owner 2026-11-06: no "reply yes" during a live call).
addColumnIfMissing("calls", "verify_deferred", "TEXT");
addColumnIfMissing("calls", "profile", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "tts_model", "TEXT NOT NULL DEFAULT ''");
// What Reason looked up on a call, one entry per tool run. The platform hands each turn back as
// spoken words only, so without this the next turn cannot see that a search happened, and on call 41
// (2026-10-23) it read out a real Kitco gold price and one turn later told him it had never looked.
addColumnIfMissing("calls", "lookups", "TEXT NOT NULL DEFAULT '[]'");
db.exec(`
  -- "Make this call for me", said on a call with the owner (2026-10-07 addendum, section 8). One
  -- row per request, carrying the brief and the authorization state, so the dial is something code
  -- decided from a row and not something a model asked for. States, in order:
  --   preparing        the request is written down and has been read back; waiting for their yes
  --   dialing          authorized, and the outgoing call is placed (placed_call_id points at it)
  --   waiting          the outgoing call is in progress — on hold, in a menu, talking
  --   needs_your_word  the outgoing call paused on something only the owner can decide
  --   result           the outgoing call ended; result holds what came of it
  --   cancelled        revoked before any effect, or stopped with the effect named
  CREATE TABLE IF NOT EXISTS call_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    -- The owner call it was asked on, and the job it belongs to.
    asked_on_call_id INTEGER NOT NULL,
    task_id INTEGER,
    to_number TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL,
    brief TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'preparing',
    -- What was read back to them before dialing, and a hash of what it was built from. A yes is
    -- tied to THIS review: if the request has changed since, the yes does not reach.
    review TEXT NOT NULL DEFAULT '',
    review_hash TEXT NOT NULL DEFAULT '',
    reviewed_at INTEGER,
    authorized_at INTEGER,
    authorized_how TEXT NOT NULL DEFAULT '',
    confirmation_id INTEGER,
    placed_call_id INTEGER,
    result TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS call_requests_open ON call_requests (conversation_id, state);
`);
// Where an access request came from: 'text' (they texted the number) or 'web' (the website form).
// A number from the form has never texted, so it is asked about and answered differently.
addColumnIfMissing("access_requests", "source", "TEXT NOT NULL DEFAULT 'text'");
// The owner's own link carries a key, so tapping it opens the page with nothing to type.
addColumnIfMissing("pages", "owner_key", "TEXT");
// A page got a one-line subtitle under its title and a closing line at the end (2026-10-06). Both
// optional; a page from before simply has neither.
addColumnIfMissing("pages", "subtitle", "TEXT");
addColumnIfMissing("pages", "closing", "TEXT");
// A browser proves itself to a person, not to a page (2026-10-17): one code on one page and every
// page of theirs opens there. Older rows were per page; they are given their page's owner.
addColumnIfMissing("page_sessions", "conversation_id", "TEXT");
db.exec(`UPDATE page_sessions SET conversation_id = (SELECT conversation_id FROM pages WHERE pages.id = page_sessions.page_id)
  WHERE conversation_id IS NULL`);
// Reason Web W1 (2026-10-26): a per-session secret the web forms carry back, so a page on another
// site cannot post as this browser (the cookie alone would ride along). Minted on first read for a
// session that predates the column.
addColumnIfMissing("page_sessions", "csrf", "TEXT");
// Sign-in sessions are kept only as a hash of the cookie (2026-11-08, security): a copy of this
// database then opens nobody's Web, pages or /ops. The browser keeps the token; every lookup hashes
// what it sent (sessionKey). Rows from before are hashed in place, once, so every browser signed in
// stays signed in. A stored key is 64 hex characters; a token we mint is 43 base64url ones, so a row
// is hashed exactly once however many times this runs.
{
  const raw = db.prepare("SELECT token FROM page_sessions WHERE length(token) != 64 OR token GLOB '*[^0-9a-f]*'").all();
  if (raw.length) {
    const upd = db.prepare("UPDATE page_sessions SET token = ? WHERE token = ?");
    const has = db.prepare("SELECT 1 FROM page_sessions WHERE token = ?");
    const drop = db.prepare("DELETE FROM page_sessions WHERE token = ?");
    db.exec("BEGIN");
    try {
      // A hash already there (the same browser, hashed by a newer process): the raw row just goes.
      for (const r of raw) {
        const key = sessionKey(r.token);
        if (has.get(key)) drop.run(r.token); else upd.run(key, r.token);
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
}
// active | paused | removed (2026-10-25). The CREATE TABLE above has had it, but a database made
// before it never got it, and live was one: every read fell back to "active", so nothing looked
// wrong, while every write — the owner's pause/resume/remove and the harm pause — would have
// thrown "no such column: state". The default is the same "active" those reads assume, so adding
// it changes nobody's answer.
addColumnIfMissing("accounts", "state", "TEXT NOT NULL DEFAULT 'active'");
// The language a person's pages carry their top line in ("twi"), 2026-10-06. Empty is English.
addColumnIfMissing("accounts", "language", "TEXT NOT NULL DEFAULT ''");
// What a page is FOR, when it is one Reason keeps rather than one it made once (2026-10-06).
// `activity` is the only one so far: the page of everything open, which has to stay at the same
// link so a person can keep it rather than hunt for the newest of nine. NULL is every ordinary
// page and always will be — a role is claimed, never inferred. See pageWithRole.
addColumnIfMissing("pages", "role", "TEXT");
// A page's state on the server (Pages v2, E4, 2026-10-27): 'active', or 'archived' once the thing
// it was for is finished and it has been put away in Saved. Its owner opening an archived link is
// told where it went (src/pages/made.js renderArchived); anybody else sees exactly what they saw
// before, so the state is never something a stranger can read off a link. The owner is the
// conversation_id the row already carries.
addColumnIfMissing("pages", "state", "TEXT NOT NULL DEFAULT 'active'");
addColumnIfMissing("pages", "archived_at", "INTEGER");
// Which job a timer, a watcher or a thing that really went out belongs to (2026-10-06). Written at
// the moment each one is made, which is the whole point: "forget the trip" has to be able to find
// everything running for the trip by LOOKING IT UP rather than by the model remembering what it
// started four hours and sixty trimmed messages ago. Null is an ordinary one that belongs to no
// job, and a row from before these columns reads as exactly that. See src/letgo.js.
addColumnIfMissing("timers", "task_id", "INTEGER");
addColumnIfMissing("watches", "task_id", "INTEGER");
addColumnIfMissing("action_ledger", "task_id", "INTEGER");
// A watch on the world rather than a page (src/parallel.js Monitor): `query` is what to watch for,
// `monitor_id` the Parallel monitor doing the watching, `last_event_id` the newest event already
// told, so a poll never tells the same one twice. url is '' on these rows.
// Where a seen url came from, for the pictures on a page (src/pages/pictures.js): `kind` is how it
// was seen — 'page' (served by a page Reason read), 'search' (an image search), 'generated' (a
// picture Reason made), 'mirror' (a copy Reason keeps) — and `from_url` the page it sits on.
addColumnIfMissing("seen_urls", "from_url", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("seen_urls", "kind", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("watches", "query", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("watches", "monitor_id", "TEXT");
addColumnIfMissing("watches", "last_event_id", "TEXT");
// Work Parallel is doing for Reason that outlives a turn: a Task API research run or a FindAll run.
// The row is how a webhook or a poll finds its way back to the research row / the job it belongs
// to. `output` is the result once fetched, so it is fetched once.
db.exec(`CREATE TABLE IF NOT EXISTS parallel_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  remote_id TEXT NOT NULL UNIQUE,
  research_id INTEGER,
  task_id INTEGER,
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  output TEXT,
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
)`);
// A heads-up that was waiting to be said and is no longer worth saying, because the job it was
// scheduled on was called off (2026-10-06). Dropped rather than deleted, so the thing is still
// recorded as seen and does not come back round as news on the next sweep. See src/letgo.js.
addColumnIfMissing("notice_seen", "dropped_at", "INTEGER");
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
addColumnIfMissing("pending_inbound", "held_times", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("pending_inbound", "down_since", "INTEGER");
// Which way the phone rang (2026-10-06). Every call before this one was placed by
// Reason, so 'out' is what an older row should read as. It matters in three places that would
// otherwise each be a guess: a call nobody placed has no goal and no approved facts, only an
// outbound call can reach a voicemail that must not be filed as a conversation, and the cap on
// minutes has to count a call that came IN as well as one that went out.
addColumnIfMissing("calls", "direction", "TEXT NOT NULL DEFAULT 'out'");
// Which job this call belongs to, when it belongs to one (2026-10-06). Same reason timers and
// watchers have it: what a call came back with is the job's news, and a job whose own log does not
// say "rang them, they said Thursday" is a job that has to be told again by somebody. Null is an
// ordinary call that belongs to no job, and every row from before reads as exactly that.
addColumnIfMissing("calls", "task_id", "INTEGER");
// Ongoing asks, per working task, whether a call for it is on the line now (taskCallLive).
db.exec("CREATE INDEX IF NOT EXISTS calls_task ON calls (conversation_id, task_id)");
// What language the call is being held in, and which languages its recorded-call disclosure has
// been spoken in (2026-10-06, with the language switch). On the call rather than in a key-value
// table because it is per-call state that should be deleted with the call and read back on the row
// afterwards: "it finished the booking in Spanish" is then a thing the record says rather than
// something the owner has to take on trust from a summary. See src/calls/voice.js.
addColumnIfMissing("calls", "language", "TEXT");
addColumnIfMissing("calls", "language_announced", "TEXT");
// When this person was told, once ever, that their calls are recorded (2026-10-06). The owner's own
// calls are recorded like every other call, but the greeting does not recite a legal disclosure at
// the person who set the thing up — so it is a text, the first time their number ever rings, and
// never again. See `recordingNoteFor` in src/calls/inbound.js.
addColumnIfMissing("accounts", "told_calls_recorded_at", "INTEGER");
// What a real phone call is actually like (2026-10-07, from the owner's spec of 2026-10-06): hold,
// phone menus, a receptionist putting the call through, and what the call ACHIEVED rather than what
// the phone did. All on the call row rather than in a side table, for the same reason the language
// columns above are: it is per-call state, it should be deleted with the call, and the record of what
// happened should be readable off one row afterwards.
//
// Waiting. `hold_since` is the hold in progress (null when not on hold) and `hold_total_s` the holds
// already finished; `holdSeconds` in src/calls/hold.js adds them. The budget is per call because a
// clinic at lunchtime is not a shop at 10am, and it is OUR clock because a voice has no hold
// detection and their silence timer may never fire against hold music at all.
addColumnIfMissing("calls", "hold_since", "INTEGER");
addColumnIfMissing("calls", "hold_total_s", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("calls", "hold_waits", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("calls", "hold_budget_s", "INTEGER");
addColumnIfMissing("calls", "hold_gave_up", "INTEGER NOT NULL DEFAULT 0");
// Who has heard the announcement. The disclosure belongs to the PERSON, not to the call: a
// receptionist who transfers us to catering has told somebody who does not know they are talking to an
// AI or that they are being recorded, so it is said again. `party_n` is who is on the line now and
// `parties_told` is which of them have heard it.
addColumnIfMissing("calls", "party_n", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("calls", "parties_told", "TEXT NOT NULL DEFAULT '[]'");
// Which keys were pressed at a phone menu, in order, so a stuck menu is visible rather than being a
// mystery four minutes of billing.
addColumnIfMissing("calls", "menu_presses", "TEXT NOT NULL DEFAULT '[]'");
// What the call ACHIEVED, from the closed set in src/calls/outcome.js — which is a different question
// from `state` (what the phone did) and comes apart from it in both directions: a call can complete
// perfectly and achieve nothing, and a call that dropped can already have got what it came for.
// `confirmation_ref` is the booking reference when there is one and `confirmation_strength` says what
// a confirmation rests on, because "they gave me a reference" and "they said yes" are not the same
// claim and the owner is shown which he has.
addColumnIfMissing("calls", "outcome_kind", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "confirmation_ref", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "confirmation_strength", "TEXT NOT NULL DEFAULT ''");
// The details that were read back, both halves: said as words, kept as exact values.
addColumnIfMissing("calls", "readback", "TEXT NOT NULL DEFAULT '{}'");
// The brief this call was placed under, kept so that what it was allowed to agree to is on the record
// and so a safe-recovery call can be built from the original rather than from a memory of it.
addColumnIfMissing("calls", "brief", "TEXT NOT NULL DEFAULT '{}'");
// Which errand this call is one leg of, when it is one of several, and which attempt at this number.
addColumnIfMissing("calls", "errand_id", "INTEGER");
addColumnIfMissing("calls", "voicemail_left", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("calls", "attempt", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("calls", "told_at", "INTEGER");
// Machines on outbound calls (2026-10-27, call 45): whether this call's opening waited for their side
// to speak instead of being spoken at pick-up, and what a recording said that the owner can use.
addColumnIfMissing("calls", "opening_waits", "INTEGER");
addColumnIfMissing("calls", "machine_heard", "TEXT");
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
// Where their most recent message came from, web included. `channel`/`address` above are the PHONE
// route — the one everything Reason starts itself (a timer, a task's news, a sign-in code) goes to —
// and a web message must never overwrite them (upsertThread). This column is the only trace a web
// message leaves on the thread; a later phase reads it for the one-line "the rest is on Web" hint
// after a switch (docs/plans/reason-web-phase1.md §7 decision 9).
addColumnIfMissing("threads", "last_channel", "TEXT");
// Decision 9 (W2): the time a TEXT arrived right after the person was on Web (0 = none owed), so
// Reason's next text to them, within the switch window, carries one line saying the whole
// conversation is on Web; taken (cleared) by that text.
addColumnIfMissing("threads", "web_hint_due", "INTEGER NOT NULL DEFAULT 0");
// When that line was said to this person. Once per PERSON, not per switch (owner 10-27: "should say
// it only once"): someone who moves between Web and texting all day heard it on every switch. Once
// set, no switch earns it again. Anyone whose outbox already carries the line was told before this
// column existed, so they are marked told as it is added and never hear it a second time.
{
  const hadTold = db.prepare("PRAGMA table_info(threads)").all().some(c => c.name === "web_hint_told_at");
  addColumnIfMissing("threads", "web_hint_told_at", "INTEGER");
  if (!hadTold) {
    db.prepare(`UPDATE threads SET web_hint_told_at = (
        SELECT MIN(created_at) FROM outbox o WHERE o.conversation_id = threads.conversation_id
          AND pt(o.body) LIKE '%the Web part included, is on Reason Web.%')
      WHERE web_hint_told_at IS NULL AND EXISTS (SELECT 1 FROM outbox o WHERE o.conversation_id = threads.conversation_id
          AND pt(o.body) LIKE '%the Web part included, is on Reason Web.%')`).run();
  }
}
// The first time this person opened their conversation on Web: the history boundary is explained
// once, then never again (spec §9: "not a recurring popup").
addColumnIfMissing("accounts", "web_notice_seen_at", "INTEGER");
// Reason Web Settings (2026-10-26). `web_reach`: where a finished job's result goes — 'web' keeps
// it on Web (Reason Web Settings, "Keep routine results here"), anything else (NULL, 'text') texts it
// as it always has. `web_theme`: paper | night | auto, chosen on Web, so every browser opens in it;
// NULL = never chosen, and the browser's own switch decides. `page_sessions.user_agent`: the browser
// a session was last used from, for the signed-in browsers list.
addColumnIfMissing("accounts", "web_reach", "TEXT");
addColumnIfMissing("accounts", "web_theme", "TEXT");
// The voice on the operator's own calls (src/calls/cartesia.js): "" is today's voice, "cartesia" the trial.
// Only read with REASON_CALL_CARTESIA=owner, and only on the operator's account.
addColumnIfMissing("accounts", "call_trial", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("page_sessions", "user_agent", "TEXT");
// Which client a session was issued to: NULL for a browser, 'ios' for the app (src/ios/session.js).
// The iPhone API only accepts sessions it issued, so a Web cookie is never a bearer token there.
addColumnIfMissing("page_sessions", "client", "TEXT");
// Reason Web v2 (Gap 8C): browser notifications, per browser. 1 = this browser asked for them (and its
// own permission was granted when it did); 0, the default, = off. Only ever says "Reason needs your approval."
addColumnIfMissing("page_sessions", "web_notify", "INTEGER NOT NULL DEFAULT 0");
// Reason Web §4h "while you were out", per browser. `web_seen_at`: this browser's last page visit
// (a signed-in page drawn — not the stream or a poll, which `last_seen_at` already counts).
// `web_away_from` / `web_away_to`: a return after 3+ hours away, from the visit before it to the
// visit that came back; set by webVisit, spent (back to NULL) by the thread that shows the line.
addColumnIfMissing("page_sessions", "web_seen_at", "INTEGER");
addColumnIfMissing("page_sessions", "web_away_from", "INTEGER");
addColumnIfMissing("page_sessions", "web_away_to", "INTEGER");
// Reason Web §4h "take it back": when the person took a Web message back before its turn started.
// Set only together with the held row's removal (cancelHeldInbound), so cancelled and started can
// never both be true of one message.
addColumnIfMissing("inbound_messages", "cancelled_at", "INTEGER");
// The short plain title an Ongoing row shows on Web, written once when the row is made (src/itemtitle.js).
addColumnIfMissing("tasks", "label", "TEXT");
// What a closed task hands back on Web's Ongoing, BACK TO YOU (src/ongoing.js): for `done`, the
// result card (a headline, a few typed facts, one note); for `failed`, why in Reason's own words and
// what happens next. Written by task_finish; JSON, null on rows closed before 10-26.
addColumnIfMissing("tasks", "result_json", "TEXT");
// The dollar figure a confirmation asked about (confirm_request's `amount`), so a receipt can show it.
addColumnIfMissing("confirmations", "amount_cents", "INTEGER");
// An ask that ran out (2026-10-30, see expireStaleAsks): closed as a no, never a yes. `expiry_told_at`
// is when the model was shown it once, so it can let them know in a line if it still matters.
addColumnIfMissing("confirmations", "expired_at", "INTEGER");
addColumnIfMissing("confirmations", "expiry_told_at", "INTEGER");
addColumnIfMissing("timers", "label", "TEXT");
addColumnIfMissing("series", "label", "TEXT");
// The short drafts Web's "Talk about it in the chat →" puts in the composer (src/itemtitle.js), one per
// state the row can be in, in the person's own voice: JSON {waiting, working, ...}. Written by the same
// summarise that writes `label`, never by a call of its own; null on older rows (a plain fallback then).
addColumnIfMissing("tasks", "drafts", "TEXT");
addColumnIfMissing("timers", "drafts", "TEXT");
addColumnIfMissing("series", "drafts", "TEXT");
// The row's one-line description for its detail page, in plain sentence case (owner 10-27): written by the
// same summarise as `label` (src/itemtitle.js), null on older rows (src/ongoing.js cleans the note then).
// `drafts` above is no longer written (the composer draft was replaced by Reason speaking first).
addColumnIfMissing("tasks", "blurb", "TEXT");
addColumnIfMissing("timers", "blurb", "TEXT");
addColumnIfMissing("series", "blurb", "TEXT");
addColumnIfMissing("outbox", "send_style", "TEXT");
// Inline replies: what each inbound message said (so "the one about the table" can be found again
// by its words), which message an outbound one is pinned under, and the message this turn's reply
// has been pointed at. See src/replies.js.
addColumnIfMissing("inbound_messages", "text", "TEXT");
addColumnIfMissing("outbox", "reply_to", "TEXT");
// Which thread one of THEIR messages was sent in (2026-10-06). `reply_to` is the parent the provider
// named and `thread_root` the message the thread started with. Both kept, because on a real night
// they disagreed: Sendblue named the newest message in the conversation as the parent of a reply
// that Apple had in a different thread entirely. The root is Apple's own record of a thread and is
// what a later reply is read against; see replies.inboundReplyLine and db.threadMessages.
addColumnIfMissing("inbound_messages", "reply_to", "TEXT");
addColumnIfMissing("inbound_messages", "thread_root", "TEXT");
addColumnIfMissing("threads", "reply_target", "TEXT");
// A tapback asked for on a turn where they had asked a question: parked here, and sent only if the
// turn also produced words. See holdReaction.
addColumnIfMissing("threads", "held_reaction", "TEXT");
// A screen effect this turn's reply is to go out with (the mark_moment tool), the same shape as
// reply_target: named during the turn, spent on the one message that follows it.
addColumnIfMissing("threads", "pending_style", "TEXT");
// When this contact is actively sharing their location via Find My, the epoch-ms at which the
// share expires. Checked on every user message so Reason keeps reading live coordinates during
// the sharing window, not just on the first message that mentioned location.
addColumnIfMissing("threads", "location_sharing_until", "INTEGER");
// The last location they sent in a message (a pin or a Find My share that arrived on the webhook), as
// JSON {latitude, longitude, accuracy, duration, at}. Sendblue's live-location read does not work on a
// shared line (422 "not supported on shared lines"), so before this a pin sent twenty minutes earlier
// was invisible to get_location and Reason told them they were not sharing (2026-10-16).
addColumnIfMissing("threads", "last_location", "TEXT");
// A message that must not go out before another one has. A reply with a link in it leaves as two
// messages — the bare URL, then the words about it (src/links.js) — and "the summary arrived first"
// would be worse than either of them being late. The chain is enforced in dueOutbound and in the
// cascade inside markOutboundFailed, so it holds through a retry an hour later and through a
// restart, not just on the happy path.
addColumnIfMissing("outbox", "after_id", "INTEGER");
// The inbound handle (its external_id) of the message this one answers, stamped when it is queued inside
// that turn (src/turnlink.js); NULL for anything sent outside a turn. Carried onto the history row as
// messages.reply_to_id, which is what the iPhone app reads (docs/ios-api.md).
addColumnIfMissing("outbox", "answers_handle", "TEXT");
// A voice note's own words, and how long it was. The spec this came from asks for timing or a
// transcript reference to be kept so a specific claim can be checked later, and the conversation
// cannot do that: its history is trimmed to the last sixty messages, so a note from three days ago
// is gone from it. Kept on the item instead, which is also what a retention sweep can reach. Read
// deliberately: media_reviewed hands back a transcript only when asked for one item by id, never
// on a list, so transcripts do not pour into every turn's context.
// How long this person wants anything Reason sends on their behalf held before it really goes, in
// seconds, and the same per kind of thing as a JSON map ({"email": 60}). NULL means they have never
// said, which is the thirty seconds everybody starts with — a column that defaulted to 30 could not
// tell "they chose thirty" from "nobody ever asked", and only one of those is worth saying back.
addColumnIfMissing("accounts", "undo_seconds", "INTEGER");
addColumnIfMissing("accounts", "undo_by_kind", "TEXT");
addColumnIfMissing("media_items", "seconds", "REAL");
addColumnIfMissing("media_items", "transcript", "TEXT");
// When the retention sweep dropped those words (src/privacy.js). A dated mark rather than a silent
// NULL, so "there were never any words" and "there were, and a setting deleted them on the 4th"
// are different facts — the second one is something Reason can say instead of guessing.
addColumnIfMissing("media_items", "transcript_dropped_at", "INTEGER");
// What the model described in this photo/media, saved after the turn so later turns know what was
// in it. The coverage and detail say what HAPPENED (looked, failed, converted); this says what was
// SEEN — "two bottles of supplements: whey protein and creatine" — and is what a later turn reads
// when it needs to know what a picture contained. Written by runtime after the model responds.
addColumnIfMissing("media_items", "description", "TEXT NOT NULL DEFAULT ''");
// Where that note came from: 'photo' when the quiet pass read the photo itself (src/looked.js), 'reply'
// when that pass failed and Reason's own reply was kept instead. Only a 'photo' note is the person's
// own words for the figures check (theirOwnWords): a reply-based note is Reason's words, and a price
// it invented would vouch for itself for weeks (review 11-07). '' is a row from before this column.
addColumnIfMissing("media_items", "description_from", "TEXT NOT NULL DEFAULT ''");
// The outcome sheet (2026-10-06): everything one task is carrying — the budget, the dates, the
// people, the options already turned down and why. On the task rather than in the model's context,
// because the context is trimmed to the last sixty messages and a task outlives that. A task from
// before this column reads as an empty sheet and goes on working exactly as it did. See src/sheet.js.
addColumnIfMissing("tasks", "sheet", "TEXT NOT NULL DEFAULT '{}'");
// The handle of the text that started the job (2026-10-09), so a result that comes back hours on
// can be pinned under the message it answers rather than landing loose in a thread that has moved
// on. Null for a task nothing in a thread asked for — a deep research run started from the console,
// or a row from before the column.
addColumnIfMissing("tasks", "origin_handle", "TEXT");
// When the model asked a waiting_on_other job to come back, when that is further out than the
// floor (2026-10-13). next_wake_at is pulled in to the floor; this keeps the model's own time so a
// peek that finds nothing landed can rest the job until the earlier of the two, without a turn.
addColumnIfMissing("tasks", "wanted_wake_at", "INTEGER");
// Which task an ask for a yes belongs to, when the model names one (2026-10-06). It is what lets
// task_finish refuse `done` on a job whose gated step was asked about and never executed — "done"
// can never mean "started". Null is the ordinary case for an ask that is not part of a task, and the
// guard deliberately treats null as in scope rather than out of it: see unexecutedGatesFor.
addColumnIfMissing("confirmations", "task_id", "INTEGER");
// "text me less" and "check more often", on the account rather than in a settings file: it is a
// fact about one person, it has to survive a restart, and the install-wide default stays whatever
// REASON_NOTICE_PER_DAY / REASON_NOTICE_EVERY_MS say. NULL means "whatever the default is", which
// is different from 0 — 0 is somebody who asked for nothing unprompted at all and must get it.
addColumnIfMissing("accounts", "notice_per_day", "INTEGER");
addColumnIfMissing("accounts", "notice_every_min", "INTEGER");
// How much initiative they want, which is a different question from how many texts a day they can
// stand. NULL is the default ('timely'); 'digest' holds everything for one line at an hour they
// chose; 'off' means nothing unprompted at all and no sweep. 'notice_snooze_until' is the same
// thing for one day only, and it expires on its own rather than needing to be turned back on.
addColumnIfMissing("accounts", "notice_mode", "TEXT");
addColumnIfMissing("accounts", "notice_snooze_until", "INTEGER");
addColumnIfMissing("accounts", "notice_digest_hour", "INTEGER");
// Their zone and their waking hours, ASKED rather than assumed. NULL in all five means nobody has
// been asked yet; 'notice_window_asked_at' set with 'notice_window_answered_at' null means the
// question has gone out once and must never go out again. Until they answer, the install default
// (08:00-22:00, the calendar's zone) is what runs, which is the point of asking rather than waiting.
addColumnIfMissing("accounts", "notice_tz", "TEXT");
// Per-person zone (src/zone.js). `notice_tz` above stays THE confirmed zone — it is what they told
// Reason, and the notice sweep already trusts it first. These are what goes around it: when it was
// confirmed, the browser's own zone from Reason Web, the zone of the last location they shared, the
// one zone a travel question has already gone out about (asked once, never again for that zone), and
// the clock-time action held while the question is out, so their answer finishes it.
addColumnIfMissing("accounts", "tz_confirmed_at", "INTEGER");
addColumnIfMissing("accounts", "web_tz", "TEXT");
addColumnIfMissing("accounts", "place_tz", "TEXT");
addColumnIfMissing("accounts", "place_tz_at", "INTEGER");
addColumnIfMissing("accounts", "tz_travel_asked", "TEXT");
addColumnIfMissing("accounts", "tz_pending", "TEXT");
addColumnIfMissing("accounts", "notice_window_start", "INTEGER");
addColumnIfMissing("accounts", "notice_window_end", "INTEGER");
addColumnIfMissing("accounts", "notice_window_asked_at", "INTEGER");
addColumnIfMissing("accounts", "notice_window_answered_at", "INTEGER");
// "Pause everything": a global hold on all outbound activity — reminders, proactive, series,
// commitments — that persists across restarts and is only lifted by an explicit resume.
// `pause_prior_mode` saves the notice mode that was active before the pause so it can be restored.
addColumnIfMissing("accounts", "paused_at", "INTEGER");
addColumnIfMissing("accounts", "pause_prior_mode", "TEXT");
// Reason's contact card went to this person (src/contact.js). Once per account, ever; `tried_at`
// is what stops a failing line from meaning a card attempt on every text.
addColumnIfMissing("accounts", "contact_card_sent_at", "INTEGER");
addColumnIfMissing("accounts", "contact_card_tried_at", "INTEGER");
// The name a new person chose to save Reason under in their first chat (src/onboarding.js), and the
// random token their card's address carries so the server can draw that one card (src/http.js).
// The token names nothing about them; the card it draws holds only the name they picked and the line.
addColumnIfMissing("accounts", "contact_card_name", "TEXT");
// Phase 3 encryption at rest (restcrypt SENSITIVE3): accounts.address is sealed per person, so its
// exact match (routing, the signup cap, "stopped", web claims) goes through this keyed HMAC instead.
addColumnIfMissing("accounts", "address_bi", "TEXT");
// Not UNIQUE: the old UNIQUE(channel, address) was on the raw text, so two case forms of one email
// were two rows; the index (on the normalized form) must not turn the second one's texts into errors.
db.exec("CREATE INDEX IF NOT EXISTS accounts_address_bi ON accounts(address_bi)");
addColumnIfMissing("accounts", "contact_card_token", "TEXT");
// Reason's line moved on 2026-10-23 (src/linechange.js). One row per person who has been told —
// with the card or without it — claimed before the send, so nobody is told twice. The owner had
// already moved over by hand, so he is done from the start. `sent_at` is when they were told.
db.exec(`
  CREATE TABLE IF NOT EXISTS line_change_cards (
    conversation_id TEXT PRIMARY KEY,
    sent_at INTEGER NOT NULL
  );
`);
addColumnIfMissing("line_change_cards", "card_ok", "INTEGER");
addColumnIfMissing("line_change_cards", "card_why", "TEXT");
db.prepare("INSERT OR IGNORE INTO line_change_cards (conversation_id, sent_at, card_why) VALUES (?, ?, ?)")
  .run(config.ownerConversation, Date.parse("2026-10-23T15:50:00Z"), "moved over by hand before this existed");
// The first-chat onboarding (src/onboarding.js): where this person is in it. NULL is exempt (never in
// it), and the first time the column lands every account already there is marked 'complete', so
// nobody who existed before this is ever walked through it — an ALTER, not a CREATE TABLE column, so
// it reaches the live database (the accounts.state lesson, 2026-10-25). `_steers` counts how often
// the pending step was steered back to (once at most), `_name_asked_at` is when their name was
// asked (the prompt then stops asking it), `_nudged_at` is the one nudge, ever.
{
  const had = db.prepare("PRAGMA table_info(accounts)").all().some(c => c.name === "onboarding");
  addColumnIfMissing("accounts", "onboarding", "TEXT");
  if (!had) db.prepare("UPDATE accounts SET onboarding = 'complete' WHERE onboarding IS NULL").run();
}
addColumnIfMissing("accounts", "onboarding_at", "INTEGER");
addColumnIfMissing("accounts", "onboarding_steers", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("accounts", "onboarding_name_asked_at", "INTEGER");
addColumnIfMissing("accounts", "onboarding_nudged_at", "INTEGER");
// The welcome cards (src/welcome.js): 'direct' or 'web' once sent, else NULL. Never sent twice.
addColumnIfMissing("accounts", "welcome_cards", "TEXT");
addColumnIfMissing("accounts", "patterns", "TEXT");
addColumnIfMissing("accounts", "patterns_said", "TEXT");
addColumnIfMissing("accounts", "patterns_asked_at", "INTEGER");
addColumnIfMissing("accounts", "patterns_set_at", "INTEGER");
// Their own no-call hours for calls Reason places to other people (src/calls/brief.js `callHoursFor`):
// NULL = the install's default (REASON_CALL_QUIET_HOURS), "off", or "HH:MM-HH:MM"; with the sentence they said.
addColumnIfMissing("accounts", "call_hours", "TEXT");
addColumnIfMissing("accounts", "call_hours_said", "TEXT");
addColumnIfMissing("accounts", "call_hours_set_at", "INTEGER");
// A candidate's identity WITHOUT its state, so "one nudge per thing" can be asked of the table.
// 'key' is the thing and its state (a thread with how long it has waited), which is what makes the
// same meeting moving twice two things to say. 'thing' is just the thread or the event, which is
// what makes a reply still unanswered after another day the SAME thing and not a second nudge.
addColumnIfMissing("notice_seen", "thing", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("notice_seen", "account", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("notice_seen", "thread_id", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("notice_seen", "event_id", "TEXT NOT NULL DEFAULT ''");
// The state this was raised IN, as a value rather than as something to parse back out of 'key':
// the start time a meeting had moved to, the address that was new on an event. A recheck compares
// this against what the calendar or the mailbox says NOW, which is how "already handled" and "this
// has gone stale" are told apart without reading our own key as a string.
addColumnIfMissing("notice_seen", "state", "TEXT NOT NULL DEFAULT ''");
// The last LOCAL day somebody on 'digest' got theirs. A day rather than a timestamp, so a pass that
// runs late still counts as that day's and a process that was down all evening does not send two.
addColumnIfMissing("notice_sweeps", "last_digest_day", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("notice_sweeps", "last_rhythm_day", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("notice_sweeps", "last_subscription_check_at", "INTEGER");
addColumnIfMissing("notice_sweeps", "last_subscription_scan_at", "INTEGER");
addColumnIfMissing("subscriptions", "next_renewal_at", "INTEGER");
// Noticed, then found to be already handled: the calendar already said the new time, the reply had
// been sent, the bill had been read. A resolved row is a fourth outcome next to said/held/claimed,
// and the one that produces NO text at all. It is kept rather than deleted because "what have you
// noticed and not told me" is a question Reason has to be able to answer honestly.
addColumnIfMissing("notice_seen", "resolved_at", "INTEGER");
addColumnIfMissing("notice_seen", "resolved_why", "TEXT NOT NULL DEFAULT ''");
// Checked, and the evidence did not settle it. Carried into the frame so the line says it is not
// sure, and taken as a reason urgent is refused: unclear evidence cannot be an emergency.
addColumnIfMissing("notice_seen", "unclear", "TEXT NOT NULL DEFAULT ''");
// What this was read OFF, named: the calendar event and the thread it disagrees with, the message
// of theirs nobody answered. Stored rather than rebuilt, because a catch is frequently parked for
// hours and the turn that finally says it has to be able to open the same source the sweep saw.
// Empty on the kinds whose `what` already names everything there is.
addColumnIfMissing("notice_seen", "source", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("notice_seen", "moment_why", "TEXT NOT NULL DEFAULT ''");
// How many sweep turns have had this in front of the model and passed on it, and when the last one
// did (2026-10-18). Separate from 'holds', which also counts quiet hours, a spent day and a digest
// wait — none of which is the model saying no. This one is, and it is what lets a thing the model
// keeps declining stop being re-offered at the price of a full turn every two hours.
addColumnIfMissing("notice_seen", "offered", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("notice_seen", "offered_at", "INTEGER");
// Which standing check-in this firing belongs to (2026-10-07). NULL is every ordinary timer and
// always will be — a one-off reminder, a day-of nudge, a catch parked for later. A timer that
// carries one is one occurrence of a `series` row, and the series schedules the next after it. See
// src/series.js.
addColumnIfMissing("timers", "series_id", "INTEGER");
// A timer that ends in a PHONE CALL rather than a text (2026-10-26): "call me at 7", "wake me up at
// 6:30 with a call". `call_goal` is why Reason is ringing, in words it can open the call with, and
// NULL is every ordinary timer. When one of these fires the runtime places the call itself through
// `call_place` (to the person's own number) instead of running a model turn, and the call row made
// for it points back here through `calls.timer_id` — which is also how a retry knows the phone has
// already rung. A series carries one too, copied onto every firing it schedules.
addColumnIfMissing("timers", "call_goal", "TEXT");
// When a timer was set (Reason Web's Ongoing "See all", newest first: owner's handoff v2, sheet 2B).
// Older rows have none and sort after every dated one; nothing is guessed for them.
addColumnIfMissing("timers", "created_at", "INTEGER");
// A timer set BY a timer (2026-11-06): the turn a firing ran set the next one, which is a repeating
// check Reason keeps going itself — "scan again in an hour", every hour. `chained_from` is the timer
// whose turn made it. NULL is every timer a person or code set. A pending chained timer IS the
// chain: it counts toward the same cap a series does, its firing is held to the same "only when
// there is something new" rule, cancelling it stops the chain, and a stop or an opt-out cancels it.
// The live case: a person getting 10-24 texts a day off hourly scans, ~6 of them "nothing new".
addColumnIfMissing("timers", "chained_from", "INTEGER");
// A timer that was finished with WITHOUT running, because its time had long passed by the time
// anything could fire it (a pause, a lapse, a stopped process). Why, in a word, for the record.
addColumnIfMissing("timers", "skipped_why", "TEXT");
addColumnIfMissing("series", "call_goal", "TEXT");
addColumnIfMissing("calls", "timer_id", "INTEGER");
// The one text a scheduled call that reached nobody is owed, stamped so it goes exactly once
// whichever settle path (webhook, call_status, the lost-calls sweep) found out how the call ended.
addColumnIfMissing("calls", "missed_told_at", "INTEGER");

// What a call audit needs and nothing recorded (2026-10-30 call quality audit): why each call ended,
// what the platform says it cost, and how long the caller waited on every turn.
//
//   end_reason        one of END_REASONS in src/calls/metrics.js, or NULL when nothing said why
//   end_detail        the platform's own words for it (termination reason, error code and message)
//   cost_credits      a platform's own cost figure — CREDITS, not money (older calls)
//   cost_raw          every cost-like field the payload's metadata carried, as JSON, unread, because
//                     which of them the platform really sends has not been seen on a real payload
addColumnIfMissing("calls", "end_reason", "TEXT");
addColumnIfMissing("calls", "end_detail", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "cost_credits", "REAL");
addColumnIfMissing("calls", "cost_raw", "TEXT NOT NULL DEFAULT ''");

// One row per turn of a call: what the caller waited through. Times are from the moment the endpoint
// received the request (the platform sends it when the person stops talking) to the first content
// chunk streamed, to the first chunk that was the model's own words rather than the holding line, a
// "one sec", a canned fallback or the disclosure, and to the end of the stream. No words are kept:
// tool NAMES only, so this table is safe to read in an audit.
//
// A turn is keyed by (call, how many messages the request carried). The platform re-asks the same turn
// when it gives up on one (voice.js aborts the earlier request), and that retry is the same turn
// again, not a new one — so it replaces the row instead of adding a second. Written once, after the
// stream ends: nothing touches the database before the caller hears the first byte.
//
// A call_turns without msg_count is the first draft of this table (PR #273 before review), which only
// ever existed in local test databases and was never deployed: dropped, so the key below can be made.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'call_turns'").get()
  && !db.prepare("PRAGMA table_info(call_turns)").all().some(c => c.name === "msg_count")) {
  db.exec("DROP TABLE call_turns");
}
db.exec(`
  CREATE TABLE IF NOT EXISTS call_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    msg_count INTEGER NOT NULL,
    turn_index INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    first_content_ms INTEGER,
    first_content_kind TEXT,
    first_real_ms INTEGER,
    total_ms INTEGER,
    holding_line INTEGER NOT NULL DEFAULT 0,
    tools TEXT NOT NULL DEFAULT '[]',
    closed_early INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 1,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS call_turns_key ON call_turns (call_id, msg_count);
  CREATE INDEX IF NOT EXISTS call_turns_call ON call_turns (call_id, turn_index);
`);

/**
 * One turn, written after its stream ended. A retry of the same turn (same call, same message count)
 * replaces the earlier attempt's numbers — unless it started before them, which is the earlier
 * attempt finishing late — keeps its place in the order, and counts the attempt.
 */
export function recordCallTurn({ callId, conversationId, msgCount, kind = "", startedAt, ...f }) {
  const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  db.prepare(`INSERT INTO call_turns (call_id, conversation_id, msg_count, turn_index, kind, started_at,
      first_content_ms, first_content_kind, first_real_ms, total_ms, holding_line, tools, closed_early,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    VALUES (?, ?, ?, (SELECT COALESCE(MAX(turn_index), 0) + 1 FROM call_turns WHERE call_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (call_id, msg_count) DO UPDATE SET
      attempts = attempts + 1,
      kind = CASE WHEN excluded.started_at >= started_at THEN excluded.kind ELSE kind END,
      first_content_ms = CASE WHEN excluded.started_at >= started_at THEN excluded.first_content_ms ELSE first_content_ms END,
      first_content_kind = CASE WHEN excluded.started_at >= started_at THEN excluded.first_content_kind ELSE first_content_kind END,
      first_real_ms = CASE WHEN excluded.started_at >= started_at THEN excluded.first_real_ms ELSE first_real_ms END,
      total_ms = CASE WHEN excluded.started_at >= started_at THEN excluded.total_ms ELSE total_ms END,
      holding_line = CASE WHEN excluded.started_at >= started_at THEN excluded.holding_line ELSE holding_line END,
      tools = CASE WHEN excluded.started_at >= started_at THEN excluded.tools ELSE tools END,
      closed_early = CASE WHEN excluded.started_at >= started_at THEN excluded.closed_early ELSE closed_early END,
      input_tokens = CASE WHEN excluded.started_at >= started_at THEN excluded.input_tokens ELSE input_tokens END,
      output_tokens = CASE WHEN excluded.started_at >= started_at THEN excluded.output_tokens ELSE output_tokens END,
      cache_read_tokens = CASE WHEN excluded.started_at >= started_at THEN excluded.cache_read_tokens ELSE cache_read_tokens END,
      cache_write_tokens = CASE WHEN excluded.started_at >= started_at THEN excluded.cache_write_tokens ELSE cache_write_tokens END,
      started_at = MAX(started_at, excluded.started_at)`).run(
    callId, conversationId, int(msgCount) ?? 0, callId, kind, int(startedAt) ?? Date.now(),
    int(f.firstContentMs), f.firstContentKind ?? null, int(f.firstRealMs), int(f.totalMs),
    f.holdingLine ? 1 : 0, JSON.stringify([...(f.tools ?? [])]), f.closedEarly ? 1 : 0,
    int(f.usage?.input_tokens), int(f.usage?.output_tokens),
    int(f.usage?.cache_read_input_tokens), int(f.usage?.cache_creation_input_tokens),
  );
}

// Which voice the caller heard a turn in, and what they heard: on a GPT-Live call (src/calls/gptlive.js)
// the turn's own row times Reason's stream, which nobody hears directly, so the voice writes over the
// heard fields with its own audio timings. Empty on a turn from another provider, which is the provider on the call row.
addColumnIfMissing("call_turns", "voice", "TEXT NOT NULL DEFAULT ''");

/**
 * What the caller actually heard on one turn of a GPT-Live call: the first audio after they stopped
 * (often the voice's own acknowledgement) and the first audio after Reason's answer reached the voice.
 * Only the row Reason's turn already wrote; nothing is inserted.
 */
export function markCallTurnHeard(callId, msgCount, { voice = "", firstContentMs = null, firstRealMs = null, firstContentKind = null } = {}) {
  const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  return db.prepare(`UPDATE call_turns SET voice = ?, first_content_ms = ?, first_real_ms = ?, first_content_kind = ?
    WHERE call_id = ? AND msg_count = ?`).run(String(voice), int(firstContentMs), int(firstRealMs), firstContentKind, callId, int(msgCount) ?? 0).changes;
}

/** Every turn of one call, in order. */
export function callTurns(callId) {
  return db.prepare("SELECT * FROM call_turns WHERE call_id = ? ORDER BY turn_index ASC, id ASC").all(callId)
    .map(r => ({ ...r, tools: JSON.parse(r.tools || "[]") }));
}

// The model's own "this is enough", stamped. A cap ending a run is code saying stop; this is the
// model saying it, and it has to survive a restart the same way, or every wake re-opens a question
// somebody already has the answer to. `enough_why` is its one line for why, which is what gets said
// back when a later call tries to carry on digging.
addColumnIfMissing("research", "enough_at", "INTEGER");
addColumnIfMissing("research", "enough_why", "TEXT NOT NULL DEFAULT ''");

// Niche source discovery, on the run and on every row it produced. `research.niche` is the kind of
// ask the model named, kept on the row so a deep run still knows to check the hiring repos when it
// wakes tomorrow. `research.niche_searches` is its own counter, because the niche allowance is
// separate from the planned one (src/config.js). `research_sources.niche` and
// `research_queries.niche` mark which rows came out of the detour — without that mark an answer
// cannot say which find was the niche one, and "a source the usual results missed" becomes a thing
// Reason asserts rather than a thing the log shows. See src/niche.js.
addColumnIfMissing("research", "niche", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("research", "niche_searches", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("research_sources", "niche", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("research_queries", "niche", "TEXT NOT NULL DEFAULT ''");

// Room and the one follow-up (src/research.js capsFor, tools.js research). `big` is decided once
// when the run starts, from what the model said about the question, so a wake gets the same room.
// `continue_task_id` is the single background follow-up this run was given — set at most once, which
// is what stops a follow-up from scheduling another; `continue_day` is the install day it was given
// on, which is what the per-person daily cap counts.
addColumnIfMissing("research", "big", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("research", "continue_task_id", "INTEGER");
addColumnIfMissing("research", "continue_day", "TEXT");
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
  db.prepare(`INSERT OR IGNORE INTO accounts (conversation_id, channel, address, address_bi, name, is_operator, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .run(id, config.operatorNumbers.length ? "linq" : "console", seal3(id, address), restcrypt.addressIndex(address), seal3(id, config.ownerName ?? ""), clock.now());
}
seedOperatorAccount();

const PLAN_FIELDS = ["title", "kind", "when", "where", "who", "details", "open_questions"];

// ---------- conversations ----------
export function loadConversation(id) {
  const row = db.prepare("SELECT messages FROM conversations WHERE id = ?").get(id);
  // A destroyed key reads as "" (src/restcrypt.js): that thread is gone, which is an empty thread.
  return row ? JSON.parse(row.messages || "[]") : [];
}
export function saveConversation(id, messages) {
  // The thread never keeps what a secret box of a page held, or a credential typed into the chat
  // for a tool (src/pagesecrets.js keepableMessages). Here because this is the thread's one writer.
  db.prepare(`INSERT INTO conversations (id, messages, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`)
    .run(id, restcrypt.sealFor(id, JSON.stringify(keepableMessages(messages))), clock.now());
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
  db.prepare("UPDATE plans SET data = ?, updated_at = ? WHERE id = ? AND conversation_id = ?").run(JSON.stringify(data), clock.now(), id, conversationId);
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
  db.prepare("UPDATE plans SET status = ?, updated_at = ? WHERE id = ? AND conversation_id = ?").run(status, clock.now(), id, conversationId);
  return { ok: true, before: plan, plan: getPlan(conversationId, id) };
}

// ---------- timers ----------
export function createTimer(conversationId, { fireAt, note, planId = null, taskId = null, seriesId = null, callGoal = null, label = null, chainedFrom = null }) {
  const r = db.prepare("INSERT INTO timers (conversation_id, fire_at, note, plan_id, task_id, series_id, call_goal, label, created_at, chained_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(conversationId, fireAt, note, planId, taskId, seriesId, callGoal ? String(callGoal) : null, label || null, clock.now(), chainedFrom ?? null);
  return getTimer(conversationId, Number(r.lastInsertRowid));
}
/** The call a timer's firing placed, if the phone has already rung for it. Unscoped: the fire path holds the timer row. */
export function callByTimer(timerId) {
  // A row the provider refused before anything was dialled (state failed, no external id) is not a
  // phone that rang: a retry after that must still send the "couldn't be placed" text, so it is
  // not what this returns.
  return db.prepare("SELECT * FROM calls WHERE timer_id = ? AND NOT (state = 'failed' AND external_id IS NULL) ORDER BY id DESC LIMIT 1").get(timerId) ?? null;
}
/**
 * Claim the one "I tried to call you and couldn't reach you" text for a scheduled call. True once,
 * for the first settle path that gets here; false for every later one.
 */
export function markMissedCallTold(callId) {
  return db.prepare("UPDATE calls SET missed_told_at = ? WHERE id = ? AND missed_told_at IS NULL").run(clock.now(), callId).changes === 1;
}
export function getTimer(conversationId, id) {
  return db.prepare("SELECT * FROM timers WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
}
/**
 * Write a row's Web title once (src/itemtitle.js): only where none is set yet, so a title the model
 * wrote is never replaced by a later summarise. A series' title also goes onto its pending firing.
 */
// A call's own short title for Saved on Web (src/saved.js), written once by the same summarise as an Ongoing row's.
addColumnIfMissing("calls", "label", "TEXT");
// The after-call steps, so a restart can tell a call whose summary and audio never went out (call 57,
// 2026-10-31: a deploy 12 s after end_call killed the turn that sends them). `settle_started_at` is
// stamped once the row is written and the thread has the turns; `settled_at` once the owner was told.
addColumnIfMissing("calls", "settle_started_at", "INTEGER");
addColumnIfMissing("calls", "settled_at", "INTEGER");
addColumnIfMissing("calls", "settle_resumes", "INTEGER NOT NULL DEFAULT 0");
// Pickup to the first word they heard, in ms (2026-11-07: business calls took 4–5 s to speak and
// people hung up), what opened the call ("about" / "hello" opener clip, or "" for the live voice),
// what Reason was calling about in a few words for that opener, and the one "nobody heard it" text.
addColumnIfMissing("calls", "first_audio_ms", "INTEGER");
// Each turn of a GPT-Live call as it happened (src/calls/gptlive.js turnLog, call 76): who, the words
// the voice heard, when, and how loud their side came in. JSON, '' when there is none. Their own call
// record: emptied with the transcript by the retention sweep (src/privacy.js), gone with the row.
addColumnIfMissing("calls", "turn_log", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "pickup_opener", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "pickup_about", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "unreached_told_at", "INTEGER");
export function setItemLabel(kind, conversationId, id, label, { blurb = null } = {}) {
  const table = { task: "tasks", timer: "timers", series: "series", call: "calls" }[kind];
  if (!table || !label) return false;
  const done = db.prepare(`UPDATE ${table} SET label = ? WHERE id = ? AND conversation_id = ? AND (label IS NULL OR label = '')`).run(label, id, conversationId).changes === 1;
  if (kind === "series") db.prepare("UPDATE timers SET label = ? WHERE series_id = ? AND conversation_id = ? AND fired_at IS NULL AND cancelled_at IS NULL AND (label IS NULL OR label = '')").run(label, id, conversationId);
  if (blurb && kind !== "call") {
    db.prepare(`UPDATE ${table} SET blurb = ? WHERE id = ? AND conversation_id = ? AND blurb IS NULL`).run(blurb, id, conversationId);
    if (kind === "series") db.prepare("UPDATE timers SET blurb = ? WHERE series_id = ? AND conversation_id = ? AND fired_at IS NULL AND cancelled_at IS NULL AND blurb IS NULL").run(blurb, id, conversationId);
  }
  return done;
}
/**
 * Write a row's one-line description alone (src/itemtitle.js queueBlurb, scripts/backfill-blurbs.js): only
 * where none is set, never touching the title or anything else. A series' line also goes onto its pending firing.
 */
export function setItemBlurb(kind, conversationId, id, blurb) {
  const table = { task: "tasks", timer: "timers", series: "series" }[kind];
  if (!table || !blurb) return false;
  const done = db.prepare(`UPDATE ${table} SET blurb = ? WHERE id = ? AND conversation_id = ? AND (blurb IS NULL OR blurb = '')`).run(blurb, id, conversationId).changes === 1;
  if (kind === "series") db.prepare("UPDATE timers SET blurb = ? WHERE series_id = ? AND conversation_id = ? AND fired_at IS NULL AND cancelled_at IS NULL AND (blurb IS NULL OR blurb = '')").run(blurb, id, conversationId);
  return done;
}
export function listTimers(conversationId) {
  // Not the onboarding's nudge (src/onboarding.js): that one is code's, not a reminder of theirs.
  return db.prepare("SELECT * FROM timers WHERE conversation_id = ? AND fired_at IS NULL AND cancelled_at IS NULL AND COALESCE(label, '') NOT IN ('onboarding:nudge', 'event:after', 'cue:offer') ORDER BY fire_at").all(conversationId);
}
export function cancelTimer(conversationId, id) {
  const t = getTimer(conversationId, id);
  if (!t) return { ok: false, error: `No timer #${id}` };
  if (t.fired_at) return { ok: false, error: `Timer #${id} already fired` };
  if (t.cancelled_at) return { ok: false, error: `Timer #${id} was already cancelled` };
  db.prepare("UPDATE timers SET cancelled_at = ? WHERE id = ? AND conversation_id = ?").run(clock.now(), id, conversationId);
  return { ok: true, timer: getTimer(conversationId, id) };
}
/** Due, and not waiting out the gap after a try that failed. */
export function dueTimers(now = clock.now()) {
  return db.prepare(`SELECT * FROM timers WHERE fire_at <= ? AND fired_at IS NULL AND cancelled_at IS NULL
    AND (next_try_at IS NULL OR next_try_at <= ?) ORDER BY fire_at`).all(now, now);
}
/**
 * Finished with, for good. Called once the timer's message is in the outbox, or once it is known
 * there is nothing to send — never before the turn, which is how a reminder used to be lost.
 */
export function markTimerFired(id) {
  db.prepare("UPDATE timers SET fired_at = ?, next_try_at = NULL WHERE id = ?").run(clock.now(), id);
}
/**
 * Take one try at a timer: attempts + 1, and not due again before `nextTryAt`.
 *
 * Counted BEFORE the turn, which is the half of the old mark-first rule worth keeping: a process
 * that dies mid-turn has still spent a try, so a timer whose turn kills the process cannot do it
 * for ever. The compare-and-set in the WHERE clause means a timer that was fired or cancelled in
 * the meantime is nobody's to try. Returns the row as claimed, or null.
 */
export function claimTimerAttempt(id, { nextTryAt }) {
  const r = db.prepare(`UPDATE timers SET attempts = attempts + 1, next_try_at = ?
    WHERE id = ? AND fired_at IS NULL AND cancelled_at IS NULL`).run(nextTryAt, id);
  return r.changes === 1 ? db.prepare("SELECT * FROM timers WHERE id = ?").get(id) : null;
}
/** A try that did not get its message to the outbox. The timer stays due, from `nextTryAt`. */
export function markTimerAttemptFailed(id, { error, nextTryAt }) {
  db.prepare("UPDATE timers SET last_error = ?, next_try_at = ? WHERE id = ? AND fired_at IS NULL")
    .run(String(error ?? "").slice(0, 500), nextTryAt, id);
}
/**
 * Finished with and never run: its time had passed too long ago to be worth anything. Spent like a
 * fired timer so nothing picks it up again; `skipped_why` keeps it from reading as delivered.
 */
export function markTimerSkipped(id, { why = "late" } = {}) {
  db.prepare("UPDATE timers SET fired_at = ?, next_try_at = NULL, skipped_why = ? WHERE id = ? AND fired_at IS NULL AND cancelled_at IS NULL")
    .run(clock.now(), String(why).slice(0, 200), id);
}
/**
 * The repeating checks Reason keeps going itself: pending timers a firing set (`chained_from`).
 * One conversation's only. `except` leaves out the timer whose turn is asking, which is the link
 * being replaced rather than a new chain.
 */
export function pendingChainedTimers(conversationId, { except = null } = {}) {
  return db.prepare(`SELECT * FROM timers WHERE conversation_id = ? AND chained_from IS NOT NULL
    AND fired_at IS NULL AND cancelled_at IS NULL AND id <> ? ORDER BY fire_at`).all(conversationId, except ?? -1);
}
/**
 * Everything that comes back on its own for one person: live series plus self-set chains. The cap
 * (config.maxSeries) is on this number, counted here on every attempt so a restart cannot lose it.
 */
export function countRecurring(conversationId, { exceptTimer = null } = {}) {
  return countActiveSeries(conversationId) + pendingChainedTimers(conversationId, { except: exceptTimer }).length;
}
/**
 * Out of tries. Spent like a fired timer so nothing picks it up again, and marked as given up so
 * it can never be mistaken for one that was delivered.
 */
export function markTimerGaveUp(id, { error = null } = {}) {
  const now = clock.now();
  db.prepare("UPDATE timers SET fired_at = ?, gave_up_at = ?, next_try_at = NULL, last_error = COALESCE(?, last_error) WHERE id = ?")
    .run(now, now, error === null ? null : String(error).slice(0, 500), id);
}

// ---------- series: a check-in that keeps coming back ----------
// Rows only. Every decision about WHEN — the next occurrence, quiet hours, what a missed one means —
// is in src/series.js, so the maths is testable without a database and this file stays what it is.
export function createSeries(conversationId, { what, rule, tz, nextAt = null, callGoal = null, label = null }) {
  const r = db.prepare(`INSERT INTO series (conversation_id, what, rule, tz, next_at, created_at, call_goal, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, what, JSON.stringify(rule ?? {}), tz, nextAt, clock.now(), callGoal ? String(callGoal) : null, label || null);
  return getSeries(conversationId, Number(r.lastInsertRowid));
}
/** Scoped to the conversation, like every other get: a series in another thread is not found. */
export function getSeries(conversationId, id) {
  return db.prepare("SELECT * FROM series WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
}
/** Unscoped, for the sweep and the fire path — code that already holds a timer row of its own. */
export function seriesById(id) {
  return db.prepare("SELECT * FROM series WHERE id = ?").get(id) ?? null;
}
export function listSeries(conversationId, { includeEnded = false } = {}) {
  return includeEnded
    ? db.prepare("SELECT * FROM series WHERE conversation_id = ? ORDER BY state = 'ended', next_at, id").all(conversationId)
    : db.prepare("SELECT * FROM series WHERE conversation_id = ? AND state <> 'ended' ORDER BY next_at, id").all(conversationId);
}
/** The cap is counted here rather than held anywhere, so a restart cannot lose track of it. */
export function countActiveSeries(conversationId) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM series WHERE conversation_id = ? AND state = 'active'").get(conversationId).n);
}
/** Every live series, across conversations. The sweep's list. */
export function activeSeries() {
  return db.prepare("SELECT * FROM series WHERE state = 'active' ORDER BY next_at, id").all();
}
export function setSeriesNext(id, nextAt) {
  db.prepare("UPDATE series SET next_at = ? WHERE id = ?").run(nextAt, id);
}
/** The rule itself, for the one thing that settles after the row is made: an every-n-days anchor. */
export function setSeriesRule(id, rule) {
  db.prepare("UPDATE series SET rule = ? WHERE id = ?").run(JSON.stringify(rule ?? {}), id);
}
/**
 * active → paused → active → ended. Ending is final: an ended series is never resumed, because
 * "start checking in again" is a new arrangement and deserves to be said back as one.
 */
export function setSeriesState(conversationId, id, state, { why = null, at = clock.now() } = {}) {
  const s = getSeries(conversationId, id);
  if (!s) return { ok: false, error: `No series #${id}` };
  if (s.state === state) return { ok: false, error: `Series #${id} is already ${state}.`, series: s };
  if (s.state === "ended") return { ok: false, error: `Series #${id} already ended${s.ended_why ? ` (${s.ended_why})` : ""}.`, series: s };
  if (state === "ended") {
    db.prepare("UPDATE series SET state = 'ended', ended_at = ?, ended_why = ?, next_at = NULL, awaiting_since = NULL WHERE id = ? AND conversation_id = ?")
      .run(at, why === null ? null : String(why).slice(0, 300), id, conversationId);
  } else {
    db.prepare("UPDATE series SET state = ? WHERE id = ? AND conversation_id = ?").run(state, id, conversationId);
  }
  return { ok: true, before: s, series: getSeries(conversationId, id) };
}
/** The firing that is already made and not yet spent, if there is one. What stops a second. */
export function pendingSeriesTimer(seriesId) {
  return db.prepare(`SELECT * FROM timers WHERE series_id = ? AND fired_at IS NULL AND cancelled_at IS NULL
    ORDER BY fire_at LIMIT 1`).get(seriesId) ?? null;
}
/** Firings not yet spent, for a pause or an end: what has to be called off with the series. */
export function pendingSeriesTimers(seriesId) {
  return db.prepare(`SELECT * FROM timers WHERE series_id = ? AND fired_at IS NULL AND cancelled_at IS NULL
    ORDER BY fire_at`).all(seriesId);
}
/**
 * A check-in that really went out: counted, stamped, and now waiting on an answer.
 *
 * Called only once the message is in the outbox — a firing the model answered with NO_REPLY has
 * asked nothing, so it must not turn the next thing they say into a report about it.
 */
export function noteSeriesFired(id, { at = clock.now(), awaiting = true } = {}) {
  // A standing CALL asks nothing by text, so the next thing they say is not a report on it.
  db.prepare("UPDATE series SET fired_count = fired_count + 1, last_fired_at = ?, awaiting_since = ? WHERE id = ?")
    .run(at, awaiting ? at : null, id);
  return seriesById(id);
}
/** The one series waiting on an answer here, newest firing first. At most one is ever taken. */
export function awaitingSeries(conversationId) {
  return db.prepare(`SELECT * FROM series WHERE conversation_id = ? AND awaiting_since IS NOT NULL
    AND state <> 'ended' ORDER BY awaiting_since DESC LIMIT 1`).get(conversationId) ?? null;
}
export function setSeriesReport(id, text, { at = clock.now() } = {}) {
  db.prepare("UPDATE series SET last_report = ?, last_report_at = ?, awaiting_since = NULL WHERE id = ?")
    .run(String(text ?? "").slice(0, 500), at, id);
  return seriesById(id);
}
/** Nothing came back inside the window. The wait ends; what they said last time is left alone. */
export function clearSeriesAwaiting(id) {
  db.prepare("UPDATE series SET awaiting_since = NULL WHERE id = ?").run(id);
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

/** Lowercase, one space between words, no trailing punctuation: what is not identity, removed. */
function normalize(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,!?;:'"]+$/, "");
}

/** One subject, comparable across spelling and spacing. Case and padding are not identity. */
export function personKey(name) {
  return normalize(name);
}

/**
 * One fact, comparable across case and a trailing full stop. "Is a nurse." and "is a nurse" are
 * the same thing said twice, and the extraction model says the same thing twice constantly — it
 * re-reads the last few messages on every turn, so the wording wobbles while the content does not.
 */
export function factKey(fact) {
  return normalize(fact);
}

/** The memory page's five headings (Reason Web, handoff §5), in the page's order. See `memoryFacts`. */
export const MEMORY_GROUPS = ["preferences", "people", "places", "routines", "why"];

/**
 * What the extraction model calls the person whose conversation this is when it does not use their
 * name. They are not a second person: a fact filed under "user" is a fact about them, and left as
 * its own subject it splits one person in half, with half their facts unreachable by their name
 * (`recall` looks them up by name). Third-person pronouns are deliberately NOT in here — "her" in
 * a DM may well be somebody's sister, and filing her sister's facts onto the account holder is a
 * worse outcome than a duplicate row.
 */
const SELF_SUBJECTS = new Set(["user", "the user", "me", "myself", "i", "the person", "this person", "owner", "the owner"]);

/**
 * An email address or a phone number is how you reach a person, not a person. Left as its own
 * subject it repeats the `user` fault one layer up: `recall` looks people up by name, so facts filed
 * under "omariij20@gmail.com" are unreachable by "Omari", and the same human ends up as several
 * subjects — on the live server, four of 55 subjects were identifiers.
 *
 * Returns the identifier in a form two spellings of the same one share, or null for an ordinary
 * name. A phone number is digits with punctuation around it: anything carrying a letter is a name,
 * so "Kofi" and "O'Brien" are never read as numbers, and the 7-digit floor keeps a year or a house
 * number from qualifying.
 */
function identifierSubject(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { kind: "email", value: raw.toLowerCase() };
  if (/[\p{L}]/u.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 7 ? { kind: "phone", value: digits } : null;
}

/**
 * Every identifier this conversation's account holder demonstrably owns: the address Reason talks to
 * them on, and the label on every Google (or other) account they connected themselves — revoked ones
 * included, because an account they disconnected was still theirs.
 *
 * This is what makes resolving an identifier safe rather than a guess, and the boundary is the same
 * one `SELF_SUBJECTS` draws for pronouns: resolve only what is provably theirs. The live data is why
 * the proof is required and not assumed — "+1 (616) 410-2992" sat as a subject inside the owner's own
 * conversation, and that number is Kwesi's, a different tester. Resolving identifiers onto whoever
 * owns the thread would have filed his facts onto Omari.
 */
function ownIdentifiers(conversationId) {
  const owned = new Set();
  const addr = identifierSubject(getAccount(conversationId)?.address ?? "");
  if (addr) owned.add(addr.value);
  for (const row of db.prepare("SELECT account_label FROM connected_accounts WHERE conversation_id = ?").all(conversationId)) {
    const label = identifierSubject(row.account_label ?? "");
    if (!label) continue;
    owned.add(label.value);
    // The local part on its own, when it carries a digit. About half the time the extraction model
    // wrote these accounts down without the domain — the live server had "omariij20" and
    // "omariij25 and omariij16" as subjects of their own, beside the full addresses, which a query
    // for `name LIKE '%@%'` cannot see.
    //
    // The digit is what makes this safe, and it is the whole reason the rule is not just "the local
    // part". No person is named with a number in the middle, so "omariij20" can only be the account.
    // A letters-only local part is deliberately NOT added: the owner of "john@gmail.com" has a
    // conversation full of Johns who are not him, and folding them onto him is the misfiling that
    // matters more than a stray subject.
    const local = label.kind === "email" ? label.value.split("@")[0] : "";
    if (local && /\d/.test(local)) owned.add(local);
  }
  return owned;
}

/**
 * Whether this subject is an identifier for an account the conversation's owner provably holds — the
 * full address, the digit-bearing local part, or a list of either ("omariij25 and omariij16", which
 * is one live subject). Returns null for an ordinary name, and for an identifier that is not theirs.
 */
function ownedIdentifierSubject(conversationId, display) {
  // Every owned value carries an "@" or a digit — a full address, a digit-bearing local part, or a
  // phone number — so an ordinary name can be turned away without asking the database. This runs on
  // every `remember`, and most subjects are ordinary names.
  if (!/[@\d]/.test(String(display ?? ""))) return null;
  const owned = ownIdentifiers(conversationId);
  const id = identifierSubject(display);
  if (id) return owned.has(id.value) ? id : null;
  const parts = normalize(display).split(/\s*(?:,|&|\band\b)\s*/).filter(Boolean);
  if (!parts.length || !parts.every(p => owned.has(p))) return null;
  return { kind: "account_label", value: parts.join(" and ") };
}

/**
 * Which subject a name refers to, without creating it. A self-referential label resolves to the
 * account holder's own name once Reason has it; before that the label stands, because there is
 * nothing better to file under, and `setAccountName` folds it in the moment the name arrives.
 *
 * An identifier the account holder owns resolves the same way and for the same reason. One that is
 * not theirs does not resolve to anybody — it is reported back as `identifier`, and `remember`
 * refuses the write rather than inventing a subject named after an inbox.
 */
function resolveSubject(conversationId, name) {
  const display = String(name ?? "").trim();
  const key = personKey(display);
  const own = () => String(getAccount(conversationId)?.name ?? "").trim();

  const id = identifierSubject(display);
  const mineToOwn = ownedIdentifierSubject(conversationId, display);
  if (id || mineToOwn) {
    // Shaped like an identifier but not one of theirs: nobody it can safely be. A bare label that is
    // not theirs falls through to the ordinary-name path instead, because "omariij20" only reads as
    // an account next to an account that matches it — otherwise it is just an unusual name.
    if (!mineToOwn) return { display, key, identifier: id };
    const mine = own();
    return mine ? { display: mine, key: personKey(mine) } : { display, key, identifier: id ?? mineToOwn };
  }

  if (!SELF_SUBJECTS.has(key)) return { display, key };
  const mine = own();
  return mine ? { display: mine, key: personKey(mine) } : { display, key };
}

/**
 * Whether a fact says nothing beyond what Reason already holds about one of this conversation's own
 * connected accounts. #31 dropped a fact that only restates a name the subject already carries;
 * this is the same principle against a different authority — `connected_accounts` owns whether an
 * account is connected and `subscriptions` owns which account a charge comes from, so a
 * `person_facts` row repeating either is a stale copy of live state rather than something learned.
 *
 * Nine rows on the live server were one account being disconnected and reconnected over a single
 * morning, written five times in five wordings; two more listed which subscriptions billed to which
 * inbox, and both were already wrong — they named 4 and 3 merchants where `subscriptions.source`
 * had all 12 with per-merchant attribution.
 *
 * Two gates keep this narrow. The fact has to be *about an account Reason actually holds*, named
 * either by the subject or in the sentence — "Ama disconnected from her family" is not about a
 * connected account and is kept, whatever words it uses. And the account has to be the thing the
 * state is predicated on, not merely something the sentence mentions.
 *
 * That second gate came out of the dry run against the live database, which is the only reason it
 * exists. Matching on the word "disconnected" anywhere ate "expressed frustration that the
 * assistant disconnected omariij20@gmail.com without telling them" — the single most useful row in
 * the set, the one that is why Reason says something before it disconnects anything now. What
 * somebody made of a change to their account is theirs and is not written down anywhere else; only
 * the state itself is already held. So a sentence carrying how they felt or what they asked for is
 * kept even when the account's state is in it too.
 */
function accountStateFact(conversationId, subjectDisplay, fact) {
  const text = normalize(fact);
  // Account labels only: a phone number is how Reason reaches them, not an account whose state it
  // holds, so the all-digits entries are no business of this test.
  const owned = [...ownIdentifiers(conversationId)].filter(v => !/^\d+$/.test(v));
  if (!owned.length) return false;

  const subject = identifierSubject(subjectDisplay);
  const aboutOwnedAccount = (subject && owned.includes(subject.value)) || owned.some(label => text.includes(label));
  if (!aboutOwnedAccount) return false;

  // How they took it, or what they wanted done, is about the person. Checked first so that it wins
  // over every state shape below: the account's state being in the sentence too does not make the
  // sentence a copy of it.
  if (/\b(?:frustrat|annoy|upset|angry|furious|complain|regret|worried|confus|relieved|glad|surprised|embarrass)/.test(text)) return false;
  if (/\b(?:without telling|did ?n[o']?t tell|never told|wants?|wanted|prefers?|asked|asks|needs?|expects?)\b/.test(text)) return false;

  // Connection state with the account as its subject: "<account> was disconnected", "<account> is
  // connected again". Anchored, so a sentence that merely names a connected account is not mistaken
  // for one that reports its state. `[^.;]` keeps a match inside one clause.
  // The account can be named by a word for one or by the label itself: the shortest live rows are
  // "omariij25 is still connected.", which carry no word like "account" to anchor on at all.
  const accountish = `(?:accounts?|gmail|google|email|inbox|${owned.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
  if (new RegExp(`\\b${accountish}\\b[^.;]{0,80}\\b(?:is|are|was|were|has been|had been|being|now)\\b[^.;]{0,40}\\b(?:(?:dis|re)?connected|unlinked|linked)\\b`).test(text)) return true;
  // The same claim counted or listed rather than stated: which of their accounts are connected.
  // Either order, because the live rows say both "has three accounts connected" and "has linked
  // accounts X and Y".
  if (/\b(?:has|have|had)\b[^.;]{0,40}\baccounts?\b[^.;]{0,40}\b(?:connected|linked)\b/.test(text)) return true;
  if (/\b(?:has|have|had)\b[^.;]{0,40}\b(?:connected|linked)\b[^.;]{0,40}\baccounts?\b/.test(text)) return true;
  // And named rather than counted: a list of them, which `connected_accounts` is.
  if (/\b(?:connected|linked) accounts?\b/.test(text)) return true;
  // Which subscriptions bill to this account, which `subscriptions.source` already says exactly.
  return /\bsubscriptions?\b.*\b(?:come|comes|came)\s+from\b/.test(text);
}

/**
 * The name a fact states when it states nothing else — "Her name is Irene", "The user's name is
 * Irene", "Irene's name is Irene" — or null when the sentence carries anything beyond the name.
 * The prefix list is deliberately closed: "her middle name is Irene" and "her mother's name is
 * Irene" both say something new and neither matches.
 */
function nameOnlyFact(fact) {
  const m = /^(?:(?:her|his|their|my|your|the user'?s?|user'?s?|this person'?s?|[\p{L}\p{M}'-]+'?s)\s+)?name\s+is\s+([\p{L}\p{M}'. -]{1,80})$/u
    .exec(normalize(fact));
  return m ? m[1].trim() : null;
}

/**
 * Move every fact from one subject onto another and drop the empty subject. Used when two rows turn
 * out to be the same person — the self-referential label ("user") and the name it belongs to. A
 * fact the target already holds is dropped rather than carried over, so a merge never makes the
 * memory noisier; the fact's row id survives the move, so its embedding keeps pointing at it.
 */
export function mergePerson(fromId, intoId) {
  if (!fromId || !intoId || fromId === intoId) return { moved: 0, dropped: 0 };
  const target = db.prepare("SELECT id FROM people WHERE id = ?").get(intoId);
  const source = db.prepare("SELECT id FROM people WHERE id = ?").get(fromId);
  if (!target || !source) return { moved: 0, dropped: 0 };

  // What the target already holds, two ways. `known` is what it actively knows, which is what makes
  // an incoming fact surplus. `byText` is every row whatever its status, because `person_facts` is
  // UNIQUE on (person_id, fact) and a repointed row has to land somewhere that text is free.
  const known = new Set();
  const byText = new Map();
  for (const r of db.prepare("SELECT id, fact, status FROM person_facts WHERE person_id = ?").all(intoId)) {
    if (r.status === "active") known.add(factKey(r.fact));
    byText.set(r.fact, r);
  }

  const kill = db.prepare("DELETE FROM person_facts WHERE id = ?");
  const unembed = db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ? AND source_table = 'person_facts'");
  const move = db.prepare("UPDATE person_facts SET person_id = ? WHERE id = ?");
  let moved = 0;
  let dropped = 0;
  const now = clock.now();

  for (const row of db.prepare("SELECT id, fact, status FROM person_facts WHERE person_id = ? ORDER BY id").all(fromId)) {
    const key = factKey(row.fact);
    // The target already knows this. The duplicate goes rather than being carried across as a dead
    // row, which the UNIQUE constraint would not have allowed to sit beside its twin anyway.
    if (row.status === "active" && known.has(key)) {
      kill.run(row.id);
      unembed.run(row.id);
      dropped++;
      continue;
    }
    const clash = byText.get(row.fact);
    if (clash) {
      // Identical text. An active twin was caught above, so this one is dead: a dead row has
      // nothing to add, and whichever of the two is dead is the one that goes.
      if (row.status !== "active") {
        kill.run(row.id);
        unembed.run(row.id);
        dropped++;
        continue;
      }
      kill.run(clash.id);
      unembed.run(clash.id);
      byText.delete(row.fact);
    }
    move.run(intoId, row.id);
    byText.set(row.fact, row);
    if (row.status === "active") known.add(key);
    moved++;
  }

  db.prepare("DELETE FROM people WHERE id = ?").run(fromId);
  db.prepare("UPDATE people SET updated_at = ? WHERE id = ?").run(now, intoId);
  return { moved, dropped };
}

/**
 * The subject this name refers to, or null. Reads without creating, for a caller deciding whether
 * a fact is worth saving at all: a check that comes to nothing must not leave an empty subject
 * behind, and must not bump `updated_at` on one that was never written to.
 */
export function findPerson(conversationId, name) {
  const { key } = resolveSubject(conversationId, name);
  return db.prepare("SELECT * FROM people WHERE conversation_id = ? AND key = ?").get(conversationId, key) ?? null;
}

/** Find or create the subject, keeping the first spelling as the display name. */
export function upsertPerson(conversationId, name) {
  const { display, key } = resolveSubject(conversationId, name);
  const existing = db.prepare("SELECT * FROM people WHERE conversation_id = ? AND key = ?").get(conversationId, key);
  if (existing) {
    db.prepare("UPDATE people SET updated_at = ? WHERE id = ?").run(clock.now(), existing.id);
    return db.prepare("SELECT * FROM people WHERE id = ?").get(existing.id);
  }
  const now = clock.now();
  const r = db.prepare("INSERT INTO people (conversation_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(conversationId, display, key, now, now);
  return db.prepare("SELECT * FROM people WHERE id = ?").get(Number(r.lastInsertRowid));
}

export function personFacts(personId) {
  return db.prepare("SELECT id, fact, created_at FROM person_facts WHERE person_id = ? AND status = 'active' ORDER BY created_at, id").all(personId);
}

/**
 * Attach one fact to one subject. The same fact twice is one fact: a model that re-learns
 * something it already knew should not make the memory noisier. "The same" is read across case and
 * a trailing full stop (`factKey`), because the thing writing most of these is a model re-reading
 * the same messages every turn and phrasing them slightly differently each time.
 */
export function remember(conversationId, about, fact, { source = "user_stated", confidence = 1.0, category = "", group = "", sourceMessageIds = [] } = {}) {
  const clean = String(fact).trim();
  const filed = MEMORY_GROUPS.includes(group) ? group : "";
  const key = factKey(clean);
  const subject = resolveSubject(conversationId, about);

  // Somebody's own name is not a fact about them. It already has a home — the account row `my_name`
  // writes, and this subject's own name — so a row saying it adds nothing, and the extraction model
  // restates it on every turn in new words ("Her name is Irene", "The user's name is Irene",
  // "Irene's name is Irene"), piling up rows for the one thing Reason is surest of. Only dropped
  // when the name stated IS this subject or the account holder: "my sister's name is Ama" filed
  // under "sister" is the link between the two, which is real, and is kept. Checked before the
  // subject is created, so a write that comes to nothing does not leave an empty subject behind.
  const stated = nameOnlyFact(clean);
  if (stated) {
    const own = personKey(getAccount(conversationId)?.name ?? "");
    const said = personKey(stated);
    if (said && (said === subject.key || (own && said === own))) {
      const existing = db.prepare("SELECT * FROM people WHERE conversation_id = ? AND key = ?").get(conversationId, subject.key);
      return {
        about: existing?.name ?? subject.display, fact: clean, already_knew: true, factId: null, redundant: "name",
        knows: existing ? personFacts(existing.id).map(f => f.fact) : [],
      };
    }
  }

  // Both refusals below come before the subject is created, for the same reason the name check does:
  // a write that comes to nothing must not leave an empty subject behind.

  // Connection state and billing source are live state Reason holds elsewhere, so a fact repeating
  // them is a copy that goes stale the next time the account changes. Checked ahead of the subject
  // rule so that resolving an identifier onto its owner cannot carry this noise with it — the nine
  // live rows about one account's morning never reach Omari, they stop here.
  // `about` as written, not `subject.display`: the subject is what names the account, and by here it
  // may already have resolved to the person who owns it.
  if (accountStateFact(conversationId, about, clean)) {
    const existing = db.prepare("SELECT * FROM people WHERE conversation_id = ? AND key = ?").get(conversationId, subject.key);
    return {
      about: existing?.name ?? subject.display, fact: clean, already_knew: true, factId: null, redundant: "account_state",
      knows: existing ? personFacts(existing.id).map(f => f.fact) : [],
    };
  }

  // An identifier Reason cannot tie to a person it knows. It is somebody's, but which somebody is
  // exactly what is not established, and a subject named after an inbox is the fault this prevents.
  // Refused rather than guessed: the alternative is filing one tester's facts onto another.
  if (subject.identifier) {
    return {
      about: subject.display, fact: clean, already_knew: false, factId: null, redundant: "identifier",
      knows: [],
    };
  }

  const person = upsertPerson(conversationId, about);
  const rows = db.prepare("SELECT id, fact, status FROM person_facts WHERE person_id = ? ORDER BY id").all(person.id);
  const active = rows.find(r => r.status === "active" && factKey(r.fact) === key);
  let factId;
  let alreadyKnew = !!active;
  if (active) {
    factId = active.id;
  } else {
    // A non-active row saying the same thing is reactivated rather than doubled — but only on their
    // word. 'deleted' and 'corrected' are rows the PERSON took back (memory_drop, memory_fix), and
    // until 2026-10-19 the extraction model brought them straight back: it re-reads the last few
    // messages every turn, the dropped sentence is still sitting in them, and restating it flipped
    // the row to active again with nobody having said anything new. A "forget that" that lasts
    // until the next message is not a forget. So an inferred restatement of one is refused, and
    // only something they said themselves (`user_stated`, the remember tool) revives it. A row the
    // extractor itself retired as out of date ('superseded', see `retireForNewer`) is not theirs to
    // have taken back, and a state that really flips back has to be able to come back.
    const stale = rows.find(r => r.status !== "active" && (factKey(r.fact) === key || r.fact === forgottenMark(person.id, key)));
    if (stale && (stale.status === "deleted" || stale.status === "corrected") && source !== "user_stated") {
      return {
        about: person.name, fact: clean, already_knew: false, factId: null,
        refused: "taken_back", was: { id: stale.id, status: stale.status },
        knows: personFacts(person.id).map(f => f.fact),
      };
    }
    const now = clock.now();
    // Said again in their own words after a permanent forget (src/ios/memory.js): the row only holds
    // a fingerprint, so it gets the words back along with the active status.
    if (stale && isForgottenMark(stale.fact)) db.prepare("UPDATE person_facts SET fact = ? WHERE id = ?").run(sealFact(person.id, clean), stale.id);
    if (stale) {
      db.prepare("UPDATE person_facts SET status = 'active', valid_from = ?, valid_to = NULL, superseded_by = NULL, confidence = ?, source = ?, source_message_ids = ?, category = ?, memory_group = ? WHERE id = ?")
        .run(now, confidence, source, JSON.stringify(sourceMessageIds), category, filed, stale.id);
      factId = stale.id;
    } else {
      const r = db.prepare(
        `INSERT INTO person_facts (person_id, fact, created_at, valid_from, status, confidence, source, source_message_ids, category, memory_group)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      ).run(person.id, sealFact(person.id, clean), now, now, confidence, source, JSON.stringify(sourceMessageIds), category, filed);
      factId = Number(r.lastInsertRowid);
    }
  }
  return {
    about: person.name, fact: clean, already_knew: alreadyKnew, factId,
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

/**
 * Everything Reason knows about one subject, gone — and it has to be *everything*, because the
 * failure this prevents is somebody asking Reason to forget their ex and then hearing about her
 * next week.
 *
 * What it reaches, and why that is the line:
 *
 *   `people` + `person_facts`   every subject whose name CONTAINS this one as a whole word, not just
 *                               the exact spelling. "Forget everything about Kofi" has to take "Kofi
 *                               Mensah" too, or the facts come back under a slightly longer name.
 *                               Word-by-word rather than by substring, so forgetting "Ama" does not
 *                               silently take "Amanda" with it — a forget that deletes the wrong
 *                               person is its own kind of broken.
 *   `memories`                  the flat table every install had before people/person_facts. The
 *                               migration copies out of it and deliberately leaves the rows, so
 *                               without this a forgotten subject was still sitting there.
 *   the saved conversation      the tool results in the thread that carry those facts back into the
 *                               next turn. Deleting the row and leaving a `recall` result in the
 *                               history saying "allergic to shellfish" is not forgetting anything:
 *                               the model reads the history on the very next message.
 *
 * What it deliberately does NOT reach: the person's own messages. Rewriting what somebody said to
 * Reason is a different and worse thing than forgetting what Reason worked out, and the thread has
 * to still make sense. So the result says so, the README says so, and the model is told to say it if
 * they ask — along with the one thing that does take their own words too, which is a data delete.
 */
export function forgetPerson(conversationId, about) {
  const key = personKey(about);
  if (!key) return { ok: false, error: "Nothing to forget: no subject was given." };
  const needle = key.split(" ").filter(Boolean);

  // Candidates by substring in SQL, then narrowed to whole words in JS, which SQLite's LIKE cannot do.
  const rows = db.prepare("SELECT * FROM people WHERE conversation_id = ? AND (key = ? OR key LIKE ?)")
    .all(conversationId, key, `%${key}%`)
    .filter(p => p.key === key || hasWords(p.key, needle));
  // Recall reaches the calls Reason made and the thread itself (src/recallindex.js), not only saved
  // facts: a forget that left "called Yaw about the deposit" findable by "what do you remember about
  // Yaw" would be no forget (review 11-05). Cleared whether or not any fact was saved about them.
  // With nobody saved under it, the subject alone decides what recall loses — and a vague one ("that",
  // "it", "work", "money") would hide every exchange that says the word, for good (review 11-07). Only
  // a real name or topic clears recall then.
  if (!rows.length && !specificSubject(key)) return { ok: false, error: `Nothing is on record about '${about}', and it is too general to clear from recall on its own — nothing was cleared. Ask which person or thing they mean.` };
  const recall = forgetFromRecall(conversationId, [about, ...rows.map(p => p.name)]);
  const recalled = recall.calls + recall.exchanges + recall.actions + recall.reminders;
  // And the "how to treat me" rules that name them (src/dream.js), matched the same way recall is. A
  // rule is read into every turn, so one left saying "always cc Yaw" would carry a forgotten person
  // forward in every reply. 'deleted', as when they take one back, so no review can write it again.
  const rulesGone = forgetRules(conversationId, [about, ...rows.map(p => p.name)]);
  if (!rows.length) {
    if (!recalled && !rulesGone.length) return { ok: false, error: `Nothing is on record about '${about}'.` };
    return {
      ok: true, about, forgot: 0, recall_cleared: recall, rules_dropped: rulesGone.length,
      covers: "nothing was saved about them as a fact; the calls, messages, actions and reminders that mention them are out of recall. It does NOT delete their own messages to you — that is their conversation.",
      note: `Gone from recall: ${recalled} call(s), message exchange(s) and action(s) that mention ${about} will not come back in a search. Say it plainly in one line and never bring the subject up again on your own.`,
    };
  }

  const facts = [];
  const factIds = [];
  for (const p of rows) {
    const pf = db.prepare("SELECT id, fact FROM person_facts WHERE person_id = ?").all(p.id);
    for (const f of pf) { facts.push(f.fact); factIds.push(f.id); }
    db.prepare("DELETE FROM person_facts WHERE person_id = ?").run(p.id);
    db.prepare("DELETE FROM people WHERE id = ?").run(p.id);
  }
  // Clean up embeddings for all deleted facts
  for (const fid of factIds) {
    db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ? AND source_table = 'person_facts'").run(fid);
  }
  invalidateProfile(conversationId);
  // Graph cleanup: remove entities linked to these people, and their edges.
  for (const p of rows) {
    const graphEnts = entitiesForPerson(conversationId, p.id);
    for (const ge of graphEnts) {
      deleteEdgesForEntity(conversationId, ge.id);
      db.prepare("DELETE FROM graph_mentions WHERE conversation_id = ? AND entity_id = ?").run(conversationId, ge.id);
      deleteEntity(conversationId, ge.id);
    }
  }
  // The old flat table, for the same subject, narrowed the same way.
  const old = db.prepare("SELECT id, about FROM memories WHERE conversation_id = ?").all(conversationId)
    .filter(m => { const k = personKey(m.about); return k === key || hasWords(k, needle); });
  for (const m of old) db.prepare("DELETE FROM memories WHERE id = ?").run(m.id);

  // And the guesses about them. Added with the guesses table: a forget that took the facts and left
  // Reason's own readings behind would be the same failure in a new place — somebody asks for their
  // ex to be forgotten and hears what Reason worked out about her next week.
  const hunches = db.prepare("SELECT id, about, guess FROM guesses WHERE conversation_id = ?").all(conversationId)
    .filter(g => { const k = personKey(g.about); return k === key || hasWords(k, needle); });
  for (const g of hunches) db.prepare("DELETE FROM guesses WHERE id = ?").run(g.id);
  facts.push(...hunches.map(g => g.guess));

  // And why they were doing it, for the same subject. A reason is the thing that shapes how options
  // get ranked, so one left behind after "forget about the move" would go on quietly sorting by a
  // goal somebody asked to be dropped. Superseded rows go too: the whole subject is being forgotten.
  const reasons = db.prepare("SELECT id, about, why FROM whys WHERE conversation_id = ?").all(conversationId)
    .filter(w => { const k = personKey(w.about); return k === key || hasWords(k, needle); });
  for (const w of reasons) db.prepare("DELETE FROM whys WHERE id = ?").run(w.id);
  facts.push(...reasons.map(w => w.why));
  facts.push(...rulesGone);

  // And the copies of those facts sitting in the thread, where the next turn would read them. Two
  // places: the memory tools' own results, and Reason's own earlier replies — which is where a
  // forgotten fact is most likely to come back from, because the model reads its own last message
  // and repeats what it said. Only the fact itself is taken out of a reply, so the sentence around
  // it still reads; the person's name is left alone, because the name is not the thing deleted.
  const scrubbed = scrubToolResults(conversationId, { tools: MEMORY_TOOLS, mentioning: [...facts, ...rows.map(p => p.name)] })
    + redactFromReplies(conversationId, facts);

  return {
    ok: true,
    about: rows[0].name,
    also_forgot: rows.slice(1).map(p => p.name),
    forgot: facts.length,
    guesses_dropped: hunches.length,
    reasons_dropped: reasons.length,
    rules_dropped: rulesGone.length,
    old_rows_removed: old.length,
    thread_lines_cleared: scrubbed,
    recall_cleared: recall,
    covers: "every fact saved about them, under that name and any longer name containing it, plus the copies of those facts in this thread, and the calls, message exchanges, actions and reminders that mention them are out of recall. It does NOT delete their own messages to you — that is their conversation, not something you worked out.",
    note: `Gone. ${facts.length} thing(s) about ${rows.map(p => p.name).join(" and ")} are deleted and are not coming back, and nothing in the thread carries them forward.`
      + ` Say it plainly in one line and never bring the subject up again on your own.`
      + ` If they ask whether their own messages are gone too, the honest answer is no — those are theirs, and a full delete (npm run data:delete) is what takes everything.`,
  };
}

/**
 * Take a deleted fact out of Reason's own earlier replies, in place.
 *
 * Its own function rather than part of the tool-result scrub because it is a different judgment. A
 * tool result is a copy of a row and loses nothing by going; a reply is a sentence somebody read, so
 * only the fact is replaced and the sentence around it survives. The person's own messages are never
 * touched — that is their conversation, not something Reason worked out, and rewriting it is a worse
 * thing than remembering. A full data delete is what takes those.
 */
export function redactFromReplies(conversationId, facts) {
  const needles = facts.map(f => String(f ?? "").trim()).filter(f => f.length > 3);
  if (!needles.length) return 0;
  const messages = loadConversation(conversationId);
  let n = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const redact = (text) => {
      let out = String(text);
      for (const f of needles) {
        const re = new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        if (re.test(out)) { out = out.replace(re, "[deleted at their request]"); n++; }
      }
      return out;
    };
    if (typeof m.content === "string") m.content = redact(m.content);
    else if (Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === "text" && typeof b.text === "string") b.text = redact(b.text);
    }
  }
  if (n) saveConversation(conversationId, messages);
  return n;
}

// Words too common to forget by on their own (forgetPerson with nobody saved under them).
const VAGUE = new Set("is be do go no so up ok hi as if by am are was were a an the this that these those it its it's they them their there here he him his she her hers you your me my mine we us our i about all any anything everything something nothing stuff thing things one ones what which who that's said say says talk talked conversation chat message messages last earlier before today yesterday tomorrow work job money time day week month year home life people person someone somebody everyone everybody plan plans thing idea and or of to for with on in at".split(" "));
// Two letters is a name too ("Jo", "Al", 李明 — review): any length counts, the VAGUE list is the bar,
// and a lone one-letter Latin word is never a subject.
function specificSubject(key) {
  return wordsOf(key).some(w => !VAGUE.has(w) && (w.length >= 2 || /[^\x00-\x7f]/.test(w)));
}
const wordsOf = (s) => String(s ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Take a subject out of recall (src/recallindex.js): every call, message, action receipt and reminder
 * of THIS conversation that names it by whole words is marked forgotten and its vector deleted. The
 * rows stay — their messages are theirs, and the ledger is append-only — but no search, by meaning or
 * by words, reads them again, and the indexer never embeds them again. Sealed: one conversation only.
 */
export function forgetFromRecall(conversationId, names = []) {
  const out = { calls: 0, exchanges: 0, actions: 0, reminders: 0 };
  const needles = [...new Map(names.map(n => wordsOf(n)).filter(w => w.length).map(w => [w.join(" "), w])).values()];
  if (!conversationId || !needles.length) return out;
  const names_ = (text) => { const k = wordsOf(text).join(" "); return needles.some(n => hasWords(k, n)); };
  const mark = db.prepare("INSERT OR IGNORE INTO recall_forgotten (conversation_id, source_table, row_id, at) VALUES (?, ?, ?, ?)");
  const at = clock.now();
  const sweep = (table, cols, where = "") => {
    // pt(): sealed text (src/restcrypt.js) is opened before it is matched; plain text passes through.
    const like = needles.map(n => `(${cols.map(c => `LOWER(COALESCE(pt(${c}), '')) LIKE ?`).join(" OR ")})`).join(" OR ");
    const args = needles.flatMap(n => cols.map(() => `%${n[0]}%`));
    const hits = db.prepare(`SELECT id, ${cols.map(c => `COALESCE(${c}, '') AS "${c}"`).join(", ")} FROM ${table} WHERE conversation_id = ? ${where} AND (${like})`)
      .all(conversationId, ...args)
      .filter(r => names_(cols.map(c => r[c]).join(" \n ")))
      .map(r => r.id);
    for (const id of hits) mark.run(conversationId, table, id, at);
    return hits;
  };
  {
    const calls = sweep("calls", ["goal", "label", "summary"]);
    // `attempted` too (the query, title, summary, ask): recall indexes it (src/recallindex.js ledgerText).
    const actions = sweep("action_ledger", ["receipt", "target", "attempted"]);
    const reminders = sweep("timers", ["note", "label", "call_goal"]);
    const said = sweep("event_log", ["content"], "AND role IN ('user','assistant')");
    const unembed = db.prepare("DELETE FROM fact_embeddings WHERE conversation_id = ? AND source_table = ? AND fact_id = ?");
    for (const id of calls) unembed.run(conversationId, "calls", id);
    for (const id of actions) unembed.run(conversationId, "action_ledger", id);
    for (const id of reminders) unembed.run(conversationId, "timers", id);
    // An exchange's vector covers the run span_from..fact_id: any run with a forgotten line in it goes.
    const spans = db.prepare(`DELETE FROM fact_embeddings WHERE conversation_id = ? AND source_table = 'event_log'
      AND ? BETWEEN COALESCE(span_from, fact_id) AND fact_id RETURNING COALESCE(span_from, fact_id) AS from_id, fact_id AS to_id`);
    // ...and the rest of that run is indexed again without the forgotten lines (recall_reindex).
    const requeue = db.prepare("INSERT OR IGNORE INTO recall_reindex (conversation_id, span_from, span_to, at) VALUES (?, ?, ?, ?)");
    let runs = 0;
    for (const id of said) for (const r of spans.all(conversationId, id)) { requeue.run(conversationId, r.from_id, r.to_id, at); runs++; }
    Object.assign(out, { calls: calls.length, actions: actions.length, reminders: reminders.length, exchanges: Math.max(runs, said.length ? 1 : 0) });
  }
  return out;
}

/**
 * Take back every active "how to treat me" rule of THIS conversation whose wording or why names the
 * subject by whole words (the same matching as forgetFromRecall). Marked 'deleted', as when they take
 * one back themselves (dropRule), so the nightly review never writes it again. Returns the rules' text.
 */
function forgetRules(conversationId, names = []) {
  const needles = [...new Map(names.map(n => wordsOf(n)).filter(w => w.length).map(w => [w.join(" "), w])).values()];
  if (!conversationId || !needles.length) return [];
  const at = clock.now();
  const gone = [];
  for (const r of db.prepare("SELECT id, rule, why FROM treat_rules WHERE conversation_id = ? AND status = 'active'").all(conversationId)) {
    const k = wordsOf(`${r.rule} \n ${r.why}`).join(" ");
    if (!needles.some(n => hasWords(k, n))) continue;
    db.prepare("UPDATE treat_rules SET status = 'deleted', retired_at = ? WHERE id = ? AND conversation_id = ?").run(at, r.id, conversationId);
    gone.push(r.rule);
  }
  return gone;
}

/** Do the words of `needle` appear as a run inside the words of `key`? */
function hasWords(key, needle) {
  const words = String(key).split(" ").filter(Boolean);
  for (let i = 0; i + needle.length <= words.length; i++) {
    if (needle.every((w, j) => words[i + j] === w)) return true;
  }
  return false;
}

// The tools whose results are Reason's own memory read back. A forget has to clear these out of the
// thread; anything else in the history is a page, a plan or a search, and rewriting those would be
// rewriting the conversation rather than forgetting a fact.
const MEMORY_TOOLS = ["recall", "remember", "forget", "my_name", "memory_page", "memory_fix", "memory_drop", "taste_note", "why_note"];

/** The same list, for a correction that has to reach the copies of a wrong reading in the thread. */
export const MEMORY_TOOL_NAMES = MEMORY_TOOLS;

/**
 * Take the content out of tool results already saved in a conversation, in place.
 *
 * Used by two different things for the same reason: a tool result is a copy, and deleting the
 * original while a copy sits in the thread means the next turn reads the copy. `forget` uses it on
 * the memory tools; a disconnect uses it on everything that was read out of the account being cut
 * off (see `scrubAccountContent`).
 *
 * Which tool a result came from is not on the result — it carries a `tool_use_id` — so the ids are
 * mapped from the assistant message that asked for it, which is the only place the name exists.
 * The block is replaced with a sentence saying what happened rather than removed, because a
 * tool_result that disappears leaves a tool_use with no answer, which no model handles well.
 */
export function scrubToolResults(conversationId, { tools = null, mentioning = null } = {}) {
  const messages = loadConversation(conversationId);
  if (!messages.length) return 0;
  const want = tools ? new Set(tools) : null;
  const needles = (mentioning ?? []).map(t => String(t ?? "").trim().toLowerCase()).filter(t => t.length > 2);
  const names = new Map();
  let cleared = 0;

  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === "tool_use") names.set(b.id, b.name);
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type !== "tool_result" || typeof b.content !== "string") continue;
      const name = names.get(b.tool_use_id);
      if (want && !want.has(name)) continue;
      const text = b.content.toLowerCase();
      if (needles.length && !needles.some(n => text.includes(n))) continue;
      b.content = JSON.stringify({ deleted: "This was deleted at their request and is not coming back. Do not guess at what was in it." });
      cleared++;
    }
  }
  if (cleared) saveConversation(conversationId, messages);
  return cleared;
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

/**
 * One pass over memory as it already stands, for the three ways it had got noisier than the person
 * it is about. All three were read off a live nine-message conversation with one new tester on
 * 2026-10-18: her name saved five times in five wordings, one fact saved twice over a trailing full
 * stop, and half of what she had said filed under "user" where nothing looking her up by her name
 * would ever have found it. `remember` stops all three happening again; this is the backlog.
 *
 * Safe to run twice — it is marked done, and a second pass would find nothing anyway.
 */
export function tidyPersonFacts() {
  if (metaGet("person_facts_tidied")) return { already_done: true, refiled: 0, duplicates: 0, names: 0 };
  const now = clock.now();
  const drop = db.prepare("UPDATE person_facts SET status = 'deleted', valid_to = ? WHERE id = ?");
  const unembed = db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ? AND source_table = 'person_facts'");
  let refiled = 0;
  let duplicates = 0;
  let names = 0;

  // The label and the name are one person.
  for (const a of db.prepare("SELECT conversation_id, name FROM accounts WHERE name IS NOT NULL AND TRIM(name) != ''").all()) {
    const strays = db.prepare("SELECT id, key FROM people WHERE conversation_id = ?").all(a.conversation_id)
      .filter(p => SELF_SUBJECTS.has(p.key) && p.key !== personKey(a.name));
    if (!strays.length) continue;
    const into = upsertPerson(a.conversation_id, a.name);
    for (const s of strays) {
      if (s.id === into.id) continue;
      const r = mergePerson(s.id, into.id);
      refiled += r.moved;
      duplicates += r.dropped;
    }
  }

  // The same fact twice, across case and a trailing full stop. The oldest wording stands.
  for (const p of db.prepare("SELECT id FROM people").all()) {
    const seen = new Set();
    for (const f of db.prepare("SELECT id, fact FROM person_facts WHERE person_id = ? AND status = 'active' ORDER BY created_at, id").all(p.id)) {
      const key = factKey(f.fact);
      if (seen.has(key)) {
        drop.run(now, f.id);
        unembed.run(f.id);
        duplicates++;
      } else {
        seen.add(key);
      }
    }
  }

  // Their own name, saved as though it were something learned about them.
  for (const row of db.prepare(`SELECT f.id, f.fact, p.key AS subject, a.name AS owner
      FROM person_facts f JOIN people p ON p.id = f.person_id
      LEFT JOIN accounts a ON a.conversation_id = p.conversation_id
      WHERE f.status = 'active'`).all()) {
    const stated = nameOnlyFact(row.fact);
    if (!stated) continue;
    const said = personKey(stated);
    const owner = personKey(row.owner ?? "");
    if (said && (said === row.subject || (owner && said === owner))) {
      drop.run(now, row.id);
      unembed.run(row.id);
      names++;
    }
  }

  metaSet("person_facts_tidied", new Date(now).toISOString());
  return { already_done: false, refiled, duplicates, names };
}
// Called further down, after the columns it reads (`status`, `valid_to`) have been added to
// person_facts and after fact_embeddings exists.

/**
 * The same backlog one layer up: subjects that are identifiers rather than people, and the facts
 * underneath them that only restated live system state. Its own marker, because
 * `person_facts_tidied` is already set on every install that ran the first pass.
 *
 * Read off the live server on 2026-10-18: four of 55 subjects were an email address or a phone
 * number, and the eleven active facts under them were all account bookkeeping — nine wordings of one
 * account being disconnected and reconnected across one morning, and two stale lists of which
 * subscriptions billed to which inbox.
 *
 * Order matters. Account-state facts go first, so the merge that follows carries only real facts
 * onto the account holder instead of importing that morning's noise onto the person Reason knows
 * best. An identifier that is *not* provably the owner's is never merged onto anybody; if it is
 * empty it goes, and if it still holds facts it is left alone and counted, because guessing whose it
 * is would be the one outcome worse than a stray subject.
 *
 * Safe to run twice — it is marked done, and a second pass would find nothing anyway.
 */
export function tidyIdentifierSubjects() {
  if (metaGet("person_facts_identifiers_tidied")) {
    return { already_done: true, state_facts: 0, resolved: 0, refiled: 0, duplicates: 0, emptied: 0, left: [] };
  }
  const now = clock.now();
  const drop = db.prepare("UPDATE person_facts SET status = 'deleted', valid_to = ? WHERE id = ?");
  const unembed = db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ? AND source_table = 'person_facts'");
  let stateFacts = 0;
  let resolved = 0;
  let refiled = 0;
  let duplicates = 0;
  let emptied = 0;
  const left = [];

  // Facts that only restate what `connected_accounts` and `subscriptions` already hold.
  for (const row of db.prepare(`SELECT f.id, f.fact, p.name AS subject, p.conversation_id AS conv
      FROM person_facts f JOIN people p ON p.id = f.person_id
      WHERE f.status = 'active'`).all()) {
    if (!accountStateFact(row.conv, row.subject, row.fact)) continue;
    drop.run(now, row.id);
    unembed.run(row.id);
    stateFacts++;
  }

  // Identifier subjects: onto their owner when the identifier is provably theirs, otherwise left.
  for (const p of db.prepare("SELECT id, conversation_id, name, key FROM people ORDER BY id").all()) {
    const id = identifierSubject(p.name);
    const owned = ownedIdentifierSubject(p.conversation_id, p.name);
    if (!id && !owned) continue;

    const owner = String(getAccount(p.conversation_id)?.name ?? "").trim();
    if (owner && owned) {
      const into = upsertPerson(p.conversation_id, owner);
      if (into.id === p.id) continue;
      // `mergePerson` repoints dead rows as well as live ones, deliberately, so a dropped fact's
      // history follows the person it was about — which makes its own `moved` the wrong number to
      // report here. What matters is how many facts somebody can now actually read under their name,
      // so that is measured on the target rather than counted on the way past.
      const readableBefore = db.prepare("SELECT count(*) AS n FROM person_facts WHERE person_id = ? AND status = 'active'").get(into.id).n;
      const r = mergePerson(p.id, into.id);
      const readableAfter = db.prepare("SELECT count(*) AS n FROM person_facts WHERE person_id = ? AND status = 'active'").get(into.id).n;
      refiled += readableAfter - readableBefore;
      duplicates += r.dropped;
      resolved++;
      continue;
    }

    const held = db.prepare("SELECT count(*) AS n FROM person_facts WHERE person_id = ? AND status = 'active'").get(p.id).n;
    if (held) {
      left.push({ subject: p.name, conversation_id: p.conversation_id, facts: held });
      continue;
    }
    db.prepare("DELETE FROM person_facts WHERE person_id = ?").run(p.id);
    db.prepare("DELETE FROM people WHERE id = ?").run(p.id);
    emptied++;
  }

  metaSet("person_facts_identifiers_tidied", new Date(now).toISOString());
  return { already_done: false, state_facts: stateFacts, resolved, refiled, duplicates, emptied, left };
}
// Called further down, alongside tidyPersonFacts, for the same reason.

// ---------- action ledger ----------
export function recordAction({ conversationId, action, target = "", attempted, outcome, result, receipt, confirmationId = null, permissionId = null, taskId = null }) {
  const r = db.prepare(`INSERT INTO action_ledger
    (conversation_id, action, target, attempted, outcome, result, receipt, confirmation_id, permission_id, created_at, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, action, target, JSON.stringify(attempted ?? {}), outcome,
         JSON.stringify(result ?? {}), receipt, confirmationId, permissionId, clock.now(),
         // Which job this really belonged to: what the caller knew, or — far more often — the job
         // whose yes paid for it. A gated action always carries the confirmation it spent and a
         // confirmation always knows its task, so the link survives nobody passing one.
         taskId ?? (confirmationId ? (db.prepare("SELECT task_id FROM confirmations WHERE id = ?").get(confirmationId)?.task_id ?? null) : null));
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
    confirmation_id: r.confirmation_id, permission_id: r.permission_id ?? null, at: r.created_at,
  }));
}

// ---------- saved-login log (src/savedlogins.js) ----------
// One row per save, open or removal of a saved login, written by savedlogins.js recordLoginEvent
// beside its action_ledger row. The logins themselves live in data/logins.db; this is the person's
// own record of their use. Never a username, a code or an address with a query string. `event` and
// `outcome` come from fixed lists in savedlogins.js (not a CHECK, so a later event needs no rebuild).
// `purpose` is sealed under the person's key (restcrypt SENSITIVE).
db.exec(`
  CREATE TABLE IF NOT EXISTS login_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    site TEXT NOT NULL DEFAULT '',
    event TEXT NOT NULL,
    outcome TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT '',
    kms_calls INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS login_log_by_conversation ON login_log (conversation_id, at);
`);

// ---------- confirmations ----------
export function askConfirmation({ conversationId, action, summary, stakes, target = "", askedAfterMsgs, taskId = null, amount = null, threadKey = null }) {
  const cents = Number.isFinite(Number(amount)) && amount !== null && amount !== "" ? Math.round(Number(amount) * 100) : null;
  // `thread_key`: the Web-only chat the ask was made in (its history key, src/db.js historyKeyFor);
  // null = the shared thread. `asked_after_msgs` counts THAT thread's messages, and only that thread's
  // answer can grant it.
  const key = threadKey && threadKey !== conversationId ? String(threadKey) : null;
  const r = db.prepare(`INSERT INTO confirmations
    (conversation_id, action, summary, stakes, target, asked_at, asked_after_msgs, task_id, amount_cents, thread_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, action, summary, stakes, target, clock.now(), askedAfterMsgs, taskId, cents, key);
  return getConfirmation(conversationId, Number(r.lastInsertRowid));
}

/**
 * The thread lost its oldest lines: move every "after this many of their messages" mark back by
 * the number that went, so the marks still point at the same place.
 *
 * Two things count their way into a thread rather than keeping a pointer into it: an open
 * confirmation (`asked_after_msgs`, the owner's own texts — see ownerTexts in src/trust.js) and a
 * call's texted check (`verify_sent_after_msgs`, every user line — see src/calls/verify.js). Both
 * read "has anything arrived since" as "is the count now higher than it was". A thread trimmed to a
 * fixed size stops growing, so without this a yes sent after the ask would never be counted as new
 * once the thread was full. Floored at zero: a mark older than everything left means everything
 * left came after it, which is exactly what zero says. See saveThread in src/thread.js.
 */
export function shiftThreadMarks(historyId, { ownerTexts = 0, userLines = 0 } = {}) {
  // `historyId` is the thread that was cut: a conversation's own, or one Web-only chat's
  // ("<conversation>#web:<chat>"). Only the marks made in THAT thread move.
  const cut = /^(.*)#web:[A-Za-z0-9_-]{22}$/.exec(String(historyId ?? ""));
  const conversationId = cut ? cut[1] : historyId;
  if (ownerTexts > 0) {
    db.prepare(`UPDATE confirmations SET asked_after_msgs = MAX(0, asked_after_msgs - ?)
      WHERE conversation_id = ? AND COALESCE(thread_key, '') = ? AND refused_at IS NULL AND consumed_at IS NULL AND granted_at IS NULL`)
      .run(ownerTexts, conversationId, cut ? String(historyId) : "");
    // Which reply said each yes moves the same way. One cut away is gone from the thread, so it can
    // never be the latest reply again: null.
    db.prepare(`UPDATE confirmations SET granted_by_msg = CASE WHEN granted_by_msg - ? >= 1 THEN granted_by_msg - ? ELSE NULL END
      WHERE conversation_id = ? AND COALESCE(thread_key, '') = ? AND granted_by_msg IS NOT NULL`)
      .run(ownerTexts, ownerTexts, conversationId, cut ? String(historyId) : "");
  }
  // A call's check is texted to their phone: it lives in the shared thread only.
  if (cut) return;
  // An open daily-limit raise counts the same way (src/spendcap.js, src/shoptools.js spend_limit_confirm).
  if (ownerTexts > 0) {
    try {
      db.prepare(`UPDATE cap_changes SET asked_after_msgs = MAX(0, asked_after_msgs - ?)
        WHERE conversation_id = ? AND status = 'asked' AND asked_after_msgs IS NOT NULL`).run(ownerTexts, conversationId);
    } catch { /* no shopping on this install: no table */ }
  }
  if (userLines > 0) {
    db.prepare(`UPDATE calls SET verify_sent_after_msgs = MAX(0, verify_sent_after_msgs - ?)
      WHERE conversation_id = ? AND verify_sent_at IS NOT NULL AND verified_at IS NULL AND verify_sent_after_msgs IS NOT NULL`)
      .run(userLines, conversationId);
  }
}

/**
 * Gated steps on this task that were asked about and never actually went through.
 *
 * This is what makes "done" mean done. A job whose last real step was "shall I submit it?" is a job
 * that was *started*, and closing it as done would be the single most corrosive lie Reason could
 * tell — it is the one the person cannot check without doing the work themselves.
 *
 * Two things about the scope, both deliberate:
 *
 *   - **A refused ask is not in here.** A no is a real answer; the job can honestly end as done
 *     without that step, and the outcome's `could_not` is where that goes.
 *   - **An ask with no task on it counts.** `task_id` is written when the model names a task, and a
 *     model that forgets to name one must not thereby escape the check. So anything asked while this
 *     task was open and not explicitly pinned to a DIFFERENT task is in scope. It can over-report —
 *     an unrelated open ask will hold a task back — and that is the safe direction: the refusal says
 *     which ask it is, and saying "that other thing is still waiting on you" is never the wrong move.
 */
export function unexecutedGatesFor(conversationId, task) {
  if (!task) return [];
  // An ask that ran out is a no, exactly like a refused one: it does not hold the task open.
  expireStaleAsks({ conversationId });
  return db.prepare(`SELECT * FROM confirmations
    WHERE conversation_id = ? AND asked_at >= ?
      AND (task_id IS NULL OR task_id = ?)
      AND refused_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL
    ORDER BY asked_at`).all(conversationId, task.created_at, task.id);
}

// ---------- asks that run out ----------
// Calls and texts to somebody else: about "now". See config.askTtlReachH.
const REACH_ASKS = new Set(["call_place", "message_send", "voice_note_send", "x_dm"]);
// Spending, or committing to something priced. See config.askTtlMoneyH.
const MONEY_ASKS = new Set(["purchase", "purchase_confirm", "uber_request", "browser_submit", "subscription_cancel_commit"]);

/** How long this ask stays answerable, in ms, by what it is for. */
export function askTtlMs(row) {
  const action = String(row?.action ?? "").replace(/^mcp__[a-z0-9_-]+__/i, "");
  // Letting somebody in: the ask lives exactly as long as their access request does
  // (config.accessWindowMin, src/access.js readMasterReply), so the two can never disagree and a yes
  // inside the request's window is never refused as a stale ask.
  if (action === "access_grant") return config.accessWindowMin * 60_000;
  const h = REACH_ASKS.has(action) ? config.askTtlReachH
    : MONEY_ASKS.has(action) || row?.amount_cents != null ? config.askTtlMoneyH
    : config.askTtlDefaultH;
  return h * 3_600_000;
}

/**
 * Why this ask is dead, or null while it can still be answered or used. Two ways to be dead:
 * an ask nobody answered in its window ("unanswered"), and a yes that was given but never used
 * within config.confirmWindowMin ("yes_unused") — that one can never authorize anything again, so
 * it is closed the same way rather than left looking open forever.
 */
export function askOverdue(row, now = clock.now()) {
  if (!row || row.consumed_at || row.refused_at) return null;
  if (row.expired_at) return row.granted_at ? "yes_unused" : "unanswered";
  if (row.granted_at) return now - row.granted_at > config.confirmWindowMin * 60_000 ? "yes_unused" : null;
  return now - row.asked_at > askTtlMs(row) ? "unanswered" : null;
}

/** Close one ask as run out. Never grants. True if this call closed it. */
export function expireConfirmation(id, now = clock.now()) {
  return db.prepare("UPDATE confirmations SET expired_at = ? WHERE id = ? AND expired_at IS NULL AND consumed_at IS NULL AND refused_at IS NULL")
    .run(now, id).changes > 0;
}

/**
 * Close every overdue ask (one conversation's, or all of them), as a no. Cheap enough to run before
 * every read of the open asks, which is how it works without a timer; scripts/expire-stale-asks.js
 * runs it across the whole database on deploy.
 *
 * `quietOlderThanMs`: an ask older than this is too old to mention to anybody, so it is closed with
 * expiry_told_at set at once. `dryRun` reports what would close and writes nothing.
 * Returns the rows it closed (or would close), each with `why` and `age_ms`. Sends nothing, ever.
 */
export function expireStaleAsks({ conversationId = null, now = clock.now(), dryRun = false, quietOlderThanMs = null } = {}) {
  const rows = db.prepare(`SELECT * FROM confirmations WHERE expired_at IS NULL AND consumed_at IS NULL AND refused_at IS NULL
    ${conversationId ? "AND conversation_id = ?" : ""} ORDER BY asked_at`).all(...(conversationId ? [conversationId] : []));
  const out = [];
  for (const r of rows) {
    const why = askOverdue(r, now);
    if (!why) continue;
    const quiet = quietOlderThanMs != null && now - r.asked_at > quietOlderThanMs;
    if (!dryRun) {
      if (!expireConfirmation(r.id, now)) continue;
      if (quiet) db.prepare("UPDATE confirmations SET expiry_told_at = ? WHERE id = ? AND expiry_told_at IS NULL").run(now, r.id);
    }
    out.push({ ...r, why, age_ms: now - r.asked_at, quiet });
  }
  return out;
}

/**
 * Asks that ran out and the model has not been shown yet. Any thread's: there is one thread now
 * (Web-only chats retired 10-27), and an ask that ran out in an old Web chat is still theirs to hear
 * about. Read-only; markExpiryTold claims them.
 */
export function expiredUntold(conversationId) {
  expireStaleAsks({ conversationId });
  return db.prepare(`SELECT * FROM confirmations WHERE conversation_id = ? AND expired_at IS NOT NULL AND expiry_told_at IS NULL
    ORDER BY asked_at DESC LIMIT 5`).all(conversationId);
}
/** Stamp these as shown. Returns the ids this call claimed, so two turns never both show one. */
export function markExpiryTold(ids, now = clock.now()) {
  const st = db.prepare("UPDATE confirmations SET expiry_told_at = ? WHERE id = ? AND expiry_told_at IS NULL");
  return ids.filter(id => st.run(now, id).changes > 0);
}
export function getConfirmation(conversationId, id) {
  return db.prepare("SELECT * FROM confirmations WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
}
export function grantConfirmation(id, quote) {
  db.prepare("UPDATE confirmations SET granted_at = ?, granted_quote = ? WHERE id = ?").run(clock.now(), quote, id);
}
/**
 * Grant an ask on the strength of one owner reply: the `byMsg`-th of their texts in this ask's thread.
 * One reply is a yes to one ask. If another ask in the same thread was already granted by that same
 * reply, nothing is granted and this returns false: two asks opened together share one mark, and a
 * "yes" aimed at the one they were shown must not also cover one they never saw (audit lead 27).
 * The check and the write are one statement, so two confirm_record calls at once cannot both win.
 */
export function grantConfirmationByReply(id, quote, byMsg) {
  return db.prepare(`UPDATE confirmations SET granted_at = ?, granted_quote = ?, granted_by_msg = ?,
      granted_upto_id = (SELECT MAX(id) FROM confirmations)
    WHERE id = ? AND granted_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM confirmations o WHERE o.id <> confirmations.id AND o.conversation_id = confirmations.conversation_id
        AND COALESCE(o.thread_key, '') = COALESCE(confirmations.thread_key, '') AND o.granted_by_msg = ?
        AND confirmations.id <= COALESCE(o.granted_upto_id, 0))`)
    .run(clock.now(), quote, byMsg, id, byMsg).changes > 0;
}
/**
 * The ask in this ask's thread that the `byMsg`-th owner reply already granted while this one was
 * already open (so both were waiting on that one reply), if any.
 */
export function grantedByReply(c, byMsg) {
  return db.prepare(`SELECT * FROM confirmations WHERE id <> ? AND conversation_id = ?
    AND COALESCE(thread_key, '') = COALESCE(?, '') AND granted_by_msg = ? AND ? <= COALESCE(granted_upto_id, 0) LIMIT 1`)
    .get(c.id, c.conversation_id, c.thread_key ?? null, byMsg, c.id) ?? null;
}
export function refuseConfirmation(id) {
  db.prepare("UPDATE confirmations SET refused_at = ? WHERE id = ?").run(clock.now(), id);
}
export function consumeConfirmation(id) {
  db.prepare("UPDATE confirmations SET consumed_at = ? WHERE id = ?").run(clock.now(), id);
}
export function pendingConfirmations(conversationId) {
  // Asks that ran out are closed first, so nothing reading this list sees one as still open.
  expireStaleAsks({ conversationId });
  return db.prepare(`SELECT * FROM confirmations WHERE conversation_id = ?
    AND refused_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL ORDER BY asked_at DESC LIMIT 10`).all(conversationId);
}

/**
 * Web-only chats are retired (owner 10-27 07:08): an ask still open in one moves to the shared thread,
 * where it is now answered. Its count restarts at `ownerTexts` (that thread's owner texts so far), so
 * only a reply from here on can be its yes. A yes already given keeps its count. Returns how many moved.
 */
export function adoptWebChatAsks(conversationId, ownerTexts) {
  // A yes already given there was a reply in that chat, not in this thread: its place there means nothing here.
  return db.prepare(`UPDATE confirmations SET thread_key = NULL, granted_by_msg = NULL,
      asked_after_msgs = CASE WHEN granted_at IS NULL THEN ? ELSE asked_after_msgs END
    WHERE conversation_id = ? AND thread_key LIKE '%#web:%' AND refused_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL`)
    .run(Math.max(0, Number(ownerTexts) || 0), conversationId).changes;
}

// ---------- connected accounts ----------
// `account` runs through all of these and means the same thing everywhere: a string picks the row for
// that one address, and leaving it out means any address. Leaving it out is what every caller written
// before one person could have several accounts does, and for a provider with one account per person
// — Spotify, every saved sign-in — every row's label is empty anyway, so those callers behave exactly
// as they did.
const labelClause = (account) => (account === undefined || account === null ? "" : " AND LOWER(account_label) = LOWER(?)");
const labelArgs = (account) => (account === undefined || account === null ? [] : [String(account)]);

export function liveAccount(conversationId, name, { account } = {}) {
  return db.prepare(`SELECT * FROM connected_accounts WHERE conversation_id = ? AND name = ? AND revoked_at IS NULL${labelClause(account)}
    ORDER BY connected_at DESC LIMIT 1`).get(conversationId, name, ...labelArgs(account)) ?? null;
}
/** Every live one, which for Google is one row per connected address. */
export function liveAccounts(conversationId, name) {
  return db.prepare("SELECT * FROM connected_accounts WHERE conversation_id = ? AND name = ? AND revoked_at IS NULL ORDER BY connected_at ASC")
    .all(conversationId, name);
}
export function connectAccount(conversationId, name, scopes, { account = "" } = {}) {
  // Connecting an address that already has a live row is a reconnect, not a second account: the row
  // is updated rather than duplicated, so a person who reconnects weekly does not accumulate a
  // history that reads as ten accounts.
  const existing = liveAccount(conversationId, name, { account });
  if (existing) {
    db.prepare("UPDATE connected_accounts SET scopes = ?, state = '', evidence = '', connected_at = ? WHERE id = ?")
      .run(JSON.stringify(scopes), clock.now(), existing.id);
    return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(existing.id);
  }
  const r = db.prepare("INSERT INTO connected_accounts (conversation_id, name, scopes, connected_at, account_label) VALUES (?, ?, ?, ?, ?)")
    .run(conversationId, name, JSON.stringify(scopes), clock.now(), String(account ?? ""));
  return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(Number(r.lastInsertRowid));
}
export function revokeAccount(conversationId, name, { account } = {}) {
  const row = liveAccount(conversationId, name, { account });
  if (!row) return null;
  db.prepare("UPDATE connected_accounts SET revoked_at = ? WHERE id = ?").run(clock.now(), row.id);
  return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(row.id);
}
export function accountHistory(conversationId) {
  return db.prepare("SELECT * FROM connected_accounts WHERE conversation_id = ? ORDER BY connected_at DESC").all(conversationId);
}

/**
 * Run `fn` (synchronous) as one transaction: everything it writes lands, or nothing does. For a
 * caller whose writes span several helpers — the onboarding's step (its queued bubbles + its state).
 */
export function atomically(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const out = fn(); db.exec("COMMIT"); return out; }
  catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
}

// ---------- the first-chat onboarding (src/onboarding.js) ----------
/** The label its one nudge timer carries; such a timer is code's, never listed as theirs. */
export const ONBOARDING_NUDGE_LABEL = "onboarding:nudge";
/**
 * Move one person's onboarding along. `state` null leaves it; a new state resets the steer count.
 * Only ever on a row that is already in it or (for `not_started`) has never been: an exempt or
 * finished person cannot be put back into it by any caller.
 */
export function setOnboarding(conversationId, { state = null, steers = null, nameAsked = false, nudged = false } = {}) {
  const now = clock.now();
  const row = getAccount(conversationId);
  if (!row) return null;
  if (state === "not_started" && row.onboarding != null) return row;
  if (state !== "not_started" && (row.onboarding == null || row.onboarding === "complete")) return row;
  db.prepare(`UPDATE accounts SET
      onboarding = COALESCE(?, onboarding),
      onboarding_at = ?,
      onboarding_steers = CASE WHEN ? IS NOT NULL THEN ? WHEN ? IS NOT NULL AND ? != COALESCE(onboarding, '') THEN 0 ELSE onboarding_steers END,
      onboarding_name_asked_at = CASE WHEN ? THEN COALESCE(onboarding_name_asked_at, ?) ELSE onboarding_name_asked_at END,
      onboarding_nudged_at = CASE WHEN ? THEN COALESCE(onboarding_nudged_at, ?) ELSE onboarding_nudged_at END
    WHERE conversation_id = ?`)
    .run(state, now, steers, steers, state, state, nameAsked ? 1 : 0, now, nudged ? 1 : 0, now, conversationId);
  return getAccount(conversationId);
}
/** Its pending nudge, if any, put down (they spoke, or the flow ended). */
export function cancelOnboardingNudges(conversationId) {
  return db.prepare("UPDATE timers SET cancelled_at = ? WHERE conversation_id = ? AND label = ? AND fired_at IS NULL AND cancelled_at IS NULL")
    .run(clock.now(), conversationId, ONBOARDING_NUDGE_LABEL).changes;
}

// ---------- accounts: one Reason per person ----------
export function getAccount(conversationId) {
  return db.prepare("SELECT * FROM accounts WHERE conversation_id = ?").get(conversationId) ?? null;
}

export function accountByAddress(channel, address) {
  return db.prepare(`SELECT * FROM accounts WHERE channel = ? AND ${ACCOUNT_ADDR_MATCH}`).get(channel, ...accountAddrArgs(address)) ?? null;
}

/**
 * The Reason belonging to one phone number, on whatever channel that number texts on.
 *
 * A conversation id has the channel in it (`dm:sendblue:+1...`), which is right for a text — it
 * arrived on a channel. A phone CALL from the same number has no channel of its own, and looking one
 * up under the call provider's name would give that person a second, empty Reason: no memory, no open
 * jobs, and a text ten minutes later landing somewhere else. So a call finds the account by its
 * number and joins the conversation that number already has (src/calls/inbound.js).
 *
 * A number with no account at all is a stranger, which is the same answer a first text gets: being
 * invited is the thing they do not have, and arriving by phone instead does not grant it.
 *
 * Newest-seen first, because a number that was moved from one channel to another should reach the
 * Reason it has been using.
 */
export function accountByNumber(address) {
  const addr = String(address ?? "").trim();
  if (!addr) return null;
  return db.prepare(`SELECT * FROM accounts WHERE ${ACCOUNT_ADDR_MATCH} ORDER BY last_seen_at DESC LIMIT 1`).get(...accountAddrArgs(addr)) ?? null;
}

/**
 * Write down that this person has been told their calls are recorded — once, ever.
 *
 * Returns true the first time and false afterwards, so the caller cannot accidentally send it twice:
 * the claim and the record are the same statement. A disclosure said once is a disclosure; said on
 * every call it is a nag, and reciting it to the person who set Reason up in the first place is
 * worse than either.
 */
export function markToldCallsRecorded(conversationId) {
  const r = db.prepare("UPDATE accounts SET told_calls_recorded_at = ? WHERE conversation_id = ? AND told_calls_recorded_at IS NULL")
    .run(clock.now(), conversationId);
  return r.changes > 0;
}

export function upsertAccount({ conversationId, channel, address, name = "", isOperator = false }) {
  const now = clock.now();
  // Phase 3: name and address sealed, address_bi beside it. An unchanged address (same index) keeps
  // its stored value rather than re-writing new ciphertext on every text.
  db.prepare(`INSERT INTO accounts (conversation_id, channel, address, address_bi, name, is_operator, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      name = CASE WHEN excluded.name != '' THEN excluded.name ELSE accounts.name END,
      -- The channel and address are updated, not kept. Somebody's seeded or old row saying 'linq'
      -- while they are actually texting over something else is a row Reason cannot reach them on,
      -- which is how the master silently stopped getting their own access questions.
      channel = excluded.channel,
      address = CASE WHEN excluded.address = '' THEN accounts.address
                     WHEN excluded.address_bi IS NOT NULL AND accounts.address_bi IS excluded.address_bi
                          AND substr(accounts.address, 1, ${restcrypt.PREFIX.length}) = '${restcrypt.PREFIX}' THEN accounts.address
                     ELSE excluded.address END,
      address_bi = CASE WHEN excluded.address = '' THEN accounts.address_bi ELSE excluded.address_bi END`)
    .run(conversationId, channel, seal3(conversationId, address), restcrypt.addressIndex(address), seal3(conversationId, name), isOperator ? 1 : 0, now, now);
  return getAccount(conversationId);
}

/** The name a person told Reason to call them. Only ever their own row. */
export function setAccountName(conversationId, name) {
  const n = String(name ?? "").trim().slice(0, 80);
  if (!n) return null;
  const r = db.prepare("UPDATE accounts SET name = ? WHERE conversation_id = ?").run(seal3(conversationId, n), conversationId);
  if (!r.changes) return null;
  // Anything saved about them before they gave their name went under a label rather than a name
  // (`SELF_SUBJECTS`) — there was nothing better to file it under. Now there is, and leaving it
  // behind would mean `recall` by their name never finding it.
  const strays = db.prepare("SELECT id, key FROM people WHERE conversation_id = ?").all(conversationId)
    .filter(p => SELF_SUBJECTS.has(p.key) && p.key !== personKey(n));
  if (strays.length) {
    const target = upsertPerson(conversationId, n);
    for (const s of strays) if (s.id !== target.id) mergePerson(s.id, target.id);
  }
  return getAccount(conversationId);
}

/** The language a person wants their pages' top line in ("twi"); "" puts it back to English. */
export function setAccountLanguage(conversationId, language) {
  const l = String(language ?? "").trim().toLowerCase().slice(0, 24);
  const r = db.prepare("UPDATE accounts SET language = ? WHERE conversation_id = ?").run(l, conversationId);
  return r.changes ? getAccount(conversationId) : null;
}

// ---------- saved places (home, work, etc.) ----------

function placeKey(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function savePlace(conversationId, { name, address, lat, lng, arriveBy = null, days = null, mode = null, travelMinutes = null, routeDescription = null }) {
  const n = String(name ?? "").trim().slice(0, 80);
  const key = placeKey(n);
  const a = String(address ?? "").trim().slice(0, 500);
  if (!key || !a || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const md = mode ? String(mode).trim().toLowerCase().slice(0, 20) : null;
  const tm = Number.isFinite(travelMinutes) && travelMinutes > 0 ? Math.round(travelMinutes) : null;
  const rd = routeDescription ? String(routeDescription).trim().slice(0, 500) : null;
  const now = clock.now();
  db.prepare(`INSERT INTO saved_places (conversation_id, name, name_key, address, lat, lng, arrive_by, days, mode, travel_minutes, route_description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id, name_key) DO UPDATE SET
      name = excluded.name, address = excluded.address, lat = excluded.lat, lng = excluded.lng,
      arrive_by = excluded.arrive_by, days = excluded.days, mode = excluded.mode,
      travel_minutes = excluded.travel_minutes, route_description = excluded.route_description,
      updated_at = excluded.updated_at`)
    .run(conversationId, n, key, seal2(conversationId, a), lat, lng, arriveBy, days, md, tm, seal2(conversationId, rd), now, now);
  return { ok: true, name: n, address: a, lat, lng, arrive_by: arriveBy, days, mode: md, travel_minutes: tm, route_description: rd };
}

export function getPlace(conversationId, name) {
  const key = placeKey(name);
  if (!key) return null;
  return db.prepare("SELECT * FROM saved_places WHERE conversation_id = ? AND name_key = ?").get(conversationId, key) ?? null;
}

export function listPlaces(conversationId) {
  return db.prepare("SELECT * FROM saved_places WHERE conversation_id = ? ORDER BY name_key").all(conversationId);
}

export function deletePlace(conversationId, name) {
  const key = placeKey(name);
  if (!key) return false;
  return db.prepare("DELETE FROM saved_places WHERE conversation_id = ? AND name_key = ?").run(conversationId, key).changes > 0;
}

/** All places with an arrive_by time — the ones the sweep checks every morning. */
export function placesWithCommute(conversationId) {
  return db.prepare("SELECT * FROM saved_places WHERE conversation_id = ? AND arrive_by IS NOT NULL").all(conversationId);
}

/** The person's home, or null. Used as the departure point for travel-time computations. */
export function getHome(conversationId) {
  const row = db.prepare("SELECT * FROM saved_places WHERE conversation_id = ? AND name_key = 'home'").get(conversationId);
  if (!row) return null;
  return { address: row.address, lat: row.lat, lng: row.lng, mode: row.mode };
}

/** The person's default travel mode, read from their home or their most-used commute place. */
export function defaultMode(conversationId) {
  const commute = db.prepare("SELECT mode FROM saved_places WHERE conversation_id = ? AND arrive_by IS NOT NULL AND mode IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(conversationId);
  return commute?.mode ?? null;
}

// ---------- the contact card (src/contact.js) ----------
/** The newest first-chat message to this person still on its way (queued, sending or unknown), else null. */
export function pendingOnboardingTail(conversationId) {
  // The end of the chain (the row nothing waits on), not the newest id: a carousel turned into its
  // pictures has rows newer than the question that follows them.
  return db.prepare(`SELECT o.id FROM outbox AS o WHERE o.conversation_id = ? AND (o.idem_key LIKE 'onboard:%' OR o.idem_key LIKE 'eventonb:%') AND o.state IN ('queued','sending','unknown')
    AND NOT EXISTS (SELECT 1 FROM outbox AS n WHERE n.after_id = o.id AND n.conversation_id = o.conversation_id AND n.state IN ('queued','sending','unknown'))
    ORDER BY o.id DESC LIMIT 1`).get(conversationId)?.id ?? null;
}

/** The welcome cards went to this person (src/onboarding.js), from the first chat or the web setup's hand-off. */
export function setWelcomeCards(conversationId, kind) {
  db.prepare("UPDATE accounts SET welcome_cards = COALESCE(welcome_cards, ?) WHERE conversation_id = ?").run(kind === "web" ? "web" : "direct", conversationId);
}

export function markContactCardTried(conversationId) {
  db.prepare("UPDATE accounts SET contact_card_tried_at = ? WHERE conversation_id = ?").run(clock.now(), conversationId);
}

export function markContactCardSent(conversationId) {
  db.prepare("UPDATE accounts SET contact_card_sent_at = ? WHERE conversation_id = ?").run(clock.now(), conversationId);
}

export function resetContactCard(conversationId) {
  db.prepare("UPDATE accounts SET contact_card_sent_at = NULL, contact_card_tried_at = NULL WHERE conversation_id = ?").run(conversationId);
}

/**
 * The name this person chose for Reason's card, with the token their card's address carries (made
 * once, kept). Returns { name, token }.
 */
export function setContactCardName(conversationId, name) {
  const row = getAccount(conversationId);
  if (!row) return null;
  const token = row.contact_card_token || randomBytes(12).toString("base64url");
  db.prepare("UPDATE accounts SET contact_card_name = ?, contact_card_token = ? WHERE conversation_id = ?").run(seal3(conversationId, name), token, conversationId);
  return { name, token };
}

/** The name on the card a token's address draws, or null for a token nobody holds. */
export function contactCardNameByToken(token) {
  if (!token) return null;
  return db.prepare("SELECT contact_card_name FROM accounts WHERE contact_card_token = ?").get(token)?.contact_card_name ?? null;
}

/**
 * Everybody who has an account and has not had the card. Oldest account first. Not somebody still
 * in the first-chat onboarding: their card comes from it, under the name they pick.
 */
export function accountsWithoutContactCard() {
  return db.prepare("SELECT * FROM accounts WHERE contact_card_sent_at IS NULL AND COALESCE(onboarding, '') NOT IN ('not_started', 'awaiting_first', 'awaiting_name', 'awaiting_card_name') ORDER BY created_at ASC").all();
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

// ---------- the new number (src/linechange.js) ----------
/**
 * Has this conversation texted the old line, and not yet been told about the new one? An inbound
 * row on that channel from before the cutoff is the whole test; the current message is never one,
 * because it was written down after the switch.
 */
export function lineChangeDue(conversationId, { channel, before }) {
  return !!db.prepare(`SELECT 1 FROM inbound_messages i
    WHERE i.conversation_id = ? AND i.channel = ? AND i.received_at < ?
      AND NOT EXISTS (SELECT 1 FROM line_change_cards l WHERE l.conversation_id = i.conversation_id)
    LIMIT 1`).get(conversationId, channel, before);
}

/** The claim. True for exactly one caller per conversation, ever. */
export function claimLineChangeCard(conversationId) {
  return db.prepare("INSERT OR IGNORE INTO line_change_cards (conversation_id, sent_at) VALUES (?, ?)")
    .run(conversationId, clock.now()).changes === 1;
}

/** What became of the card once the claim was made. The row stays either way: done is done. */
export function recordLineChangeCard(conversationId, { cardOk, why = null }) {
  db.prepare("UPDATE line_change_cards SET card_ok = ?, card_why = ? WHERE conversation_id = ?")
    .run(cardOk ? 1 : 0, why, conversationId);
}

export function getLineChangeCard(conversationId) {
  return db.prepare("SELECT * FROM line_change_cards WHERE conversation_id = ?").get(conversationId) ?? null;
}

// ---------- asking for a Reason, and the master's answer ----------
export function createAccessRequest({ channel, address, displayName = "", firstMessage, chatId = null, source = "text" }) {
  const r = db.prepare(`INSERT INTO access_requests
    (channel, address, display_name, first_message, chat_id, state, requested_at, source)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(channel, address, displayName, firstMessage, chatId, clock.now(), source);
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

/** How many people are waiting for an answer, whichever way they asked. The access page shows it. */
export function pendingRequestCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE state = 'pending'").get().n;
}

/** How many numbers the website has put in the queue since a moment, for its daily ceiling. */
export function webRequestsSince(sinceMs) {
  return db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE source = 'web' AND requested_at >= ?").get(sinceMs).n;
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
/**
 * Is this NUMBER stopped, on any line? "removed" outranks "paused"; null when no row is either.
 *
 * A pause or a removal is the master's word about a person, and a person is a number: Reason can
 * have two texting lines (Sendblue and Linq), and a stop written on one (channel, number) row must
 * not be walked round by texting the other line. The same reach as the block list (isBlocked).
 */
export function stoppedStateOf(address) {
  const addr = String(address ?? "").trim();
  if (!addr) return null;
  const rows = db.prepare(`SELECT state FROM accounts WHERE ${ACCOUNT_ADDR_MATCH} AND is_operator = 0 AND state IN ('paused', 'removed')`).all(...accountAddrArgs(addr));
  if (rows.some(r => r.state === "removed")) return "removed";
  return rows.length ? "paused" : null;
}

export function setAccountState(conversationId, state) {
  db.prepare("UPDATE accounts SET state = ? WHERE conversation_id = ?").run(state, conversationId);
  return getAccount(conversationId);
}

// ---------- global pause ----------
export function setPaused(conversationId, { at, priorMode }) {
  db.prepare("UPDATE accounts SET paused_at = ?, pause_prior_mode = ? WHERE conversation_id = ?")
    .run(at, priorMode, conversationId);
}
export function clearPaused(conversationId) {
  db.prepare("UPDATE accounts SET paused_at = NULL, pause_prior_mode = NULL WHERE conversation_id = ?")
    .run(conversationId);
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
  // Negative is a refund — a turn counted before it ran, for a model that turned out to be down
  // (src/down.js) — and never takes a day below zero.
  const n = Math.round(Number(by) || 0);
  if (!n) return usageToday(conversationId, day);
  db.prepare(`INSERT INTO usage (conversation_id, day, ${col}) VALUES (?, ?, MAX(0, ?))
    ON CONFLICT(conversation_id, day) DO UPDATE SET ${col} = MAX(0, ${col} + ?)`).run(conversationId, day, n, n);
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

/**
 * The states a task can be in while it is still alive.
 *
 * `waiting` is the original one and is kept forever: rows written before 2026-10-06 are in it, and a
 * migration that renamed them would be a migration rewriting history about what Reason was doing.
 * The three that replaced it say *who* the wait is on, which is the whole difference between a loose
 * end Reason is carrying and one the person has to pick up:
 *
 *   running           — Reason is working it
 *   waiting_on_you    — it needs one answer only they can give. `sheet.needs` says what, in a
 *                       question answerable in a word or two, with the tradeoff on one line.
 *   waiting_on_other  — it is on somebody or something else. `sheet.waiting` carries the next check,
 *                       and Reason keeps checking without being asked.
 *   blocked           — something stopped it. `sheet.blocked` says what, and what would unblock it.
 *
 * `done` and `cancelled` are closed and go through finishTask, never through updateTask.
 */
export const TASK_OPEN = ["running", "waiting", "waiting_on_you", "waiting_on_other", "blocked"];
/** The open states as a SQL list, so adding one above does not need four queries edited by hand. */
const OPEN_SQL = TASK_OPEN.map(s => `'${s}'`).join(",");

function rowToTask(r) {
  if (!r) return null;
  return {
    ...r,
    open: TASK_OPEN.includes(r.state),
    sheet: parseSheet(r.sheet),
    log: taskLog(r.id),
  };
}

export function createTask(conversationId, { title, goal, wakeAt = null, maxAttempts, sheet = null, originHandle = null, label = null }) {
  const now = clock.now();
  // The sheet is validated before the row exists, so a task never starts with a half-written one.
  const merged = applyPatch(emptySheet(), sheet, { now });
  if (!merged.ok) return merged;
  const r = db.prepare(`INSERT INTO tasks
    (conversation_id, title, goal, state, next_wake_at, max_attempts, sheet, origin_handle, created_at, updated_at, label)
    VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, title, goal, wakeAt, maxAttempts, JSON.stringify(merged.sheet), originHandle ?? null, now, now, label || null);
  const id = Number(r.lastInsertRowid);
  logTask(id, "state", `started: ${goal}`);
  return getTask(conversationId, id);
}

/**
 * Everything still running for one job, by lookup rather than by memory.
 *
 * "Forget the trip" is only answerable honestly if Reason can find what it started for the trip —
 * four hours and sixty trimmed messages later, after a restart. That is why the task id goes on a
 * timer, a watcher and a confirmation at the moment each is made. Nothing here is matched on words.
 */
export function runningFor(conversationId, taskId) {
  return {
    timers: db.prepare("SELECT * FROM timers WHERE conversation_id = ? AND task_id = ? AND fired_at IS NULL AND cancelled_at IS NULL ORDER BY fire_at").all(conversationId, taskId),
    watches: db.prepare(`SELECT * FROM watches WHERE conversation_id = ? AND task_id = ?
      AND met_at IS NULL AND cancelled_at IS NULL AND gave_up_at IS NULL ORDER BY created_at`).all(conversationId, taskId),
    confirmations: db.prepare(`SELECT * FROM confirmations WHERE conversation_id = ? AND task_id = ?
      AND refused_at IS NULL AND consumed_at IS NULL ORDER BY asked_at`).all(conversationId, taskId),
  };
}

/**
 * What really went out on this job, and therefore what "never mind" cannot take back.
 *
 * Only `ok` rows: an attempt that failed committed nothing, and listing it as committed would have
 * somebody chasing a cancellation for a booking that never happened.
 */
export function committedOn(conversationId, taskId) {
  return db.prepare("SELECT * FROM action_ledger WHERE conversation_id = ? AND task_id = ? AND outcome = 'ok' ORDER BY created_at")
    .all(conversationId, taskId)
    .map(r => ({ id: r.id, action: r.action, target: r.target, receipt: r.receipt, at: r.created_at }));
}

/** The sheet alone, for the places that only need what a task is carrying. */
export function taskSheet(id) {
  const r = db.prepare("SELECT sheet FROM tasks WHERE id = ?").get(id);
  return r ? parseSheet(r.sheet) : emptySheet();
}

/** Writes a sheet that something else has already validated. Not a tool path. */
export function writeTaskSheet(id, sheet) {
  db.prepare("UPDATE tasks SET sheet = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(parseSheet(sheet)), clock.now(), id);
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
    : `SELECT * FROM tasks WHERE conversation_id = ? AND state IN (${OPEN_SQL}) ORDER BY created_at LIMIT 30`;
  return db.prepare(sql).all(conversationId).map(rowToTask);
}

export function logTask(taskId, kind, note) {
  const r = db.prepare("INSERT INTO task_log (task_id, kind, note, at) VALUES (?, ?, ?, ?)")
    .run(taskId, kind, String(note).slice(0, 600), clock.now());
  // A call's outcome lands here (src/calls/postcall.js noteOnTask) without going through updateTask,
  // so this is where a job's watchers hear about it. updateTask/finishTask tell them once more at
  // the end of their own write; a listener reads the row as it is, so twice costs nothing.
  if (kind === "call") taskChanged(null, taskId);
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

export function updateTask(conversationId, id, { progress = null, wakeAt, state, sheet = undefined, steer = undefined } = {}) {
  const t = getTask(conversationId, id);
  if (!t) return { ok: false, error: `No task #${id}` };
  if (!t.open) return { ok: false, error: `Task #${id} is ${t.state}; it is over. Start a new one.` };
  if (state && !TASK_OPEN.includes(state)) return { ok: false, error: `'${state}' is not an open state. Use task_finish to close a task.` };
  // The sheet first, and nothing else is written if it is refused. A refusal here is usually
  // `needs_them`: Reason tried to move something only they can move, and the next step is a
  // question with the tradeoff on it rather than a quiet substitution. See src/sheet.js.
  let next = null;
  if (sheet !== undefined || steer !== undefined) {
    const now = clock.now();
    let working = t.sheet;
    if (sheet !== undefined) {
      const merged = applyPatch(working, sheet, { now });
      if (!merged.ok) return merged;
      working = merged.sheet;
    }
    if (steer !== undefined) {
      const withSteer = addSteer(working, steer ?? {}, { now });
      if (!withSteer.ok) return withSteer;
      working = withSteer.sheet;
    }
    next = working;
  }
  // A state that names who the wait is on has to say what the wait IS, or it is a label and not a
  // loose end anybody can act on. Checked against the sheet as it will be after this call, so the
  // state and the thing it needs can be set in one go — which is how the model will do it.
  const after = next ?? t.sheet;
  if (state === "waiting_on_you" && !after.needs) {
    return {
      ok: false, error: `waiting_on_you means you need ONE thing from them, so it needs sheet.needs: a question they can answer`
        + ` in a word or two, plus one line on what each answer costs. Send the state and the needs together.`
        + ` If you do not actually need an answer from them, this is running or waiting_on_other.`,
    };
  }
  if (state === "waiting_on_other" && !after.waiting.length) {
    return {
      ok: false, error: `waiting_on_other means somebody or something else owes you something, so it needs sheet.waiting:`
        + ` who (or what), for what exactly, and when you will check again. Send the state and the waiting entry together.`,
    };
  }
  if (state === "blocked" && !after.blocked) {
    return {
      ok: false, error: `blocked needs sheet.blocked: what actually stopped it, and what would get it going again.`
        + ` Send the state and that together. If there is another safe route to the same goal, take it instead of calling this blocked.`,
    };
  }
  if (progress) logTask(id, "progress", progress);
  // A route that failed goes in the progress log as well as onto the sheet. "What did you actually
  // try" is a question asked weeks later, and the log is the only thing Reason may quote about what
  // it did — so the line is written from the sheet rather than from a sentence the model typed
  // twice, and it cannot disagree with the sheet.
  if (next) {
    for (const r of next.routes.slice(t.sheet.routes.length)) {
      logTask(id, "progress", `tried ${r.tried} — did not work: ${r.failed_because}`);
    }
    // A rejection outlives the task it happened on. The sheet already makes the model read WHY and
    // give it a category, with their words kept verbatim — the only thing missing was that the
    // apartment hunt's "nothing above $2,400" never reached the dinner three weeks later. Written
    // here rather than asked of the model a second time, because a preference the model has to
    // remember to save is one that gets lost on the turns it matters most.
    const wasRejected = new Set(t.sheet.options.filter(o => o.status === "rejected").map(o => o.id));
    for (const o of next.options) {
      if (o.status !== "rejected" || wasRejected.has(o.id) || !o.rejected_because?.words) continue;
      learnPreference(conversationId, {
        category: o.rejected_because.reading,
        words: o.rejected_because.words,
        turnedDown: o.label || o.id,
        taskId: id,
      });
    }
  }
  const sets = ["updated_at = ?"];
  const args = [clock.now()];
  if (next) { sets.push("sheet = ?"); args.push(JSON.stringify(next)); }
  // A job waiting on somebody else cannot sleep past the floor. The model's time is kept as
  // wanted_wake_at; code comes back at the floor, and the runtime decides whether anything landed
  // that is worth a turn (src/landed.js) or rests it again until the earlier of the two.
  let pulledIn = null;
  if (wakeAt !== undefined) {
    const stateAfter = state ?? t.state;
    const floor = clock.now() + config.taskWaitingFloorMin * 60_000;
    if (stateAfter === "waiting_on_other" && wakeAt > floor) {
      pulledIn = { wanted: wakeAt, wake: floor };
      sets.push("next_wake_at = ?", "wanted_wake_at = ?"); args.push(floor, wakeAt);
    } else {
      sets.push("next_wake_at = ?", "wanted_wake_at = NULL"); args.push(wakeAt);
    }
  }
  if (state) { sets.push("state = ?"); args.push(state); }
  // Real progress clears the crash counter: the retry budget is for a step that keeps dying,
  // not for a task that is simply long.
  if (progress) { sets.push("attempts = 0"); }
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND conversation_id = ?`).run(...args, id, conversationId);
  taskChanged(conversationId, id);
  return { ok: true, task: getTask(conversationId, id), ...(pulledIn ? { pulled_in: pulledIn } : {}) };
}

export function finishTask(conversationId, id, { state, outcome, result = null }) {
  const t = getTask(conversationId, id);
  if (!t) return { ok: false, error: `No task #${id}` };
  if (!t.open) return { ok: false, error: `Task #${id} was already ${t.state}.` };
  logTask(id, "state", `${state}: ${outcome}`);
  db.prepare("UPDATE tasks SET state = ?, outcome = ?, next_wake_at = NULL, finished_at = ?, updated_at = ?, result_json = ? WHERE id = ? AND conversation_id = ?")
    .run(state, String(outcome).slice(0, 600), clock.now(), clock.now(), result ? JSON.stringify(result) : null, id, conversationId);
  if (state === "done") emitCompletion("task", { conversationId, id });
  taskChanged(conversationId, id);
  return { ok: true, task: getTask(conversationId, id) };
}

/**
 * Mark the one reminder a `waiting_on_you` task is allowed, and say whether it was owed.
 *
 * The rule, and it is the whole of it: Reason asks once, and after a long gap it asks **once more**.
 * Never a third time. "Own the loose ends" and "be a nuisance" are a hair apart, and the difference
 * is a stamp on a row rather than the model's sense of tact — which is exactly the kind of judgement
 * that drifts over two hundred wakes.
 *
 * Returns the needs it is time to re-raise, or null. Claimed before anything is sent, so a crash
 * mid-reminder loses the reminder rather than sending it twice.
 */
export function claimNeedsReminder(id, { gapMs, now = clock.now() }) {
  const t = getTaskAnywhere(id);
  if (!t || t.state !== "waiting_on_you" || !t.sheet.needs) return null;
  const needs = t.sheet.needs;
  if (needs.reminded_at) return null;              // already had its one nudge
  if (!needs.asked_at || now - needs.asked_at < gapMs) return null;
  const sheet = { ...t.sheet, needs: { ...needs, reminded_at: now } };
  writeTaskSheet(id, sheet);
  return { question: needs.question, tradeoff: needs.tradeoff, asked_at: needs.asked_at };
}

/** Tasks whose next wake has come. A task with no next_wake_at is open but not scheduled. */
export function dueTasks(now = clock.now()) {
  return db.prepare(`SELECT * FROM tasks
    WHERE state IN (${OPEN_SQL}) AND next_wake_at IS NOT NULL AND next_wake_at <= ?
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
  const rows = db.prepare(`SELECT id, title FROM tasks WHERE state IN (${OPEN_SQL}) AND next_wake_at IS NULL`).all();
  if (rows.length) {
    db.prepare(`UPDATE tasks SET next_wake_at = ?, updated_at = ? WHERE state IN (${OPEN_SQL}) AND next_wake_at IS NULL`)
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
 *                  nothing in the message text identifies it. The PRIMARY handle of that message,
 *                  never one of its parts: an attachment-specific handle is documented to 422, so
 *                  the router writes the base handle here and the part suffix is dropped.
 *
 * Both are COALESCEd, so a channel that reports neither never blanks what was already known.
 */
export function upsertThread({ conversationId, channel, address, chatId = null, isOwner, service = null, lastInboundId = null }) {
  const now = clock.now();
  // A web message never becomes the thread's route. `channel`/`address` are where Reason's OWN
  // messages go — a reminder, a task finishing, a sign-in code — and that has to stay the phone:
  // with a shared conversation the first web message would otherwise point every one of those at a
  // browser tab that may be closed. So a web inbound touches `last_channel`, the activity stamp and
  // the handle, and leaves the route exactly as it was. A thread that does not exist yet is not
  // created by a web message either: the phone route is proven by a text, never by a browser.
  if (channel === "web") {
    db.prepare(`UPDATE threads SET last_channel = 'web',
        last_inbound_id = COALESCE(?, last_inbound_id), updated_at = ?
      WHERE conversation_id = ?`).run(lastInboundId, now, conversationId);
    return getThread(conversationId);
  }
  // A text right after Web, within the same stretch of work, is a switch (decision 9): the next text
  // Reason sends carries the one line about Web — unless they have been told already, ever.
  const before = getThread(conversationId);
  if (before?.last_channel === "web" && !before.web_hint_told_at && now - (before.updated_at ?? 0) < WEB_SWITCH_WINDOW_MS) {
    db.prepare("UPDATE threads SET web_hint_due = ? WHERE conversation_id = ?").run(now, conversationId);
  }
  db.prepare(`INSERT INTO threads (conversation_id, channel, address, chat_id, is_owner, service, last_inbound_id, last_channel, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      channel = excluded.channel, address = excluded.address,
      chat_id = COALESCE(excluded.chat_id, threads.chat_id),
      service = COALESCE(excluded.service, threads.service),
      last_inbound_id = COALESCE(excluded.last_inbound_id, threads.last_inbound_id),
      last_channel = excluded.last_channel,
      is_owner = excluded.is_owner, updated_at = excluded.updated_at`)
    .run(conversationId, channel, address, chatId, isOwner ? 1 : 0, service, lastInboundId, channel, now, now);
  return getThread(conversationId);
}

/** How recent the last Web message must be for a text after it to count as switching mid-task (decision 9). */
export const WEB_SWITCH_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Is the decision-9 line owed on this text? Yes exactly once per PERSON (web_hint_told_at), on the
 * first switch, and only within the same window the switch was judged by: a switch whose reply never
 * went out does not ride on a reminder days later. Taking it clears it either way, and a yes marks
 * them told in the same statement, so no later switch and no second send can repeat it.
 */
export function takeWebHint(conversationId, now = clock.now()) {
  const r = db.prepare("SELECT web_hint_due AS due, web_hint_told_at AS told FROM threads WHERE conversation_id = ?").get(conversationId);
  if (!r?.due) return false;
  const fresh = !r.told && now - r.due < WEB_SWITCH_WINDOW_MS;
  const took = db.prepare(`UPDATE threads SET web_hint_due = 0,
      web_hint_told_at = CASE WHEN ? THEN ? ELSE web_hint_told_at END
    WHERE conversation_id = ? AND web_hint_due = ? AND web_hint_told_at IS ?`).run(fresh ? 1 : 0, now, conversationId, r.due, r.told ?? null).changes === 1;
  return took && fresh;
}

export function getThread(conversationId) {
  return db.prepare("SELECT * FROM threads WHERE conversation_id = ?").get(conversationId) ?? null;
}

export function setLocationSharing(conversationId, untilMs) {
  db.prepare("UPDATE threads SET location_sharing_until = ? WHERE conversation_id = ?")
    .run(untilMs ?? null, conversationId);
}

/** Keep the location they just sent, replacing the one before. */
export function recordSharedLocation(conversationId, { latitude, longitude, accuracy = null, duration = null, at = clock.now() }) {
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return;
  const row = { latitude: Number(latitude), longitude: Number(longitude), accuracy: accuracy == null ? null : Number(accuracy), duration: duration ? String(duration) : null, at };
  db.prepare("UPDATE threads SET last_location = ? WHERE conversation_id = ?").run(JSON.stringify(row), conversationId);
}

/** The last location they sent, or null. */
export function lastSharedLocation(conversationId) {
  const r = db.prepare("SELECT last_location FROM threads WHERE conversation_id = ?").get(conversationId);
  try { return r?.last_location ? JSON.parse(r.last_location) : null; } catch { return null; }
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
 * The messages in one inline-reply thread, oldest first, not counting the message that started it.
 *
 * A thread as this install knows it: their messages that arrived with this root (or with a message
 * of the thread as parent), and Reason's messages pinned under the root or under one of those.
 * Scoped to the conversation like messageByHandle, for the same reason. `except` leaves out one
 * handle — the message being read right now, which is already in the table by the time it is read.
 */
export function threadMessages(conversationId, root, { except = null, limit = 20 } = {}) {
  const r = String(root ?? "");
  if (!r) return [];
  // Theirs: sent with this root, or as a reply to a message already in the thread (a provider that
  // reports only the parent still gets the thread right, one message at a time). A few passes,
  // because each one can only find messages under what the last one found.
  const theirs = [];
  const seen = new Set([r.toLowerCase()]);
  for (let pass = 0; pass < 4; pass++) {
    const known = [...seen];
    const more = db.prepare(`
      SELECT external_id AS handle, COALESCE(text, '') AS text, received_at AS at, 'them' AS "from", id AS seq
        FROM inbound_messages
       WHERE conversation_id = ? AND LOWER(external_id) NOT IN (${known.map(() => "?").join(",")})
         AND (LOWER(thread_root) IN (${known.map(() => "?").join(",")}) OR LOWER(reply_to) IN (${known.map(() => "?").join(",")}))`)
      .all(conversationId, ...known, ...known, ...known);
    if (!more.length) break;
    for (const m of more) { seen.add(String(m.handle).toLowerCase()); theirs.push(m); }
  }
  const under = [r, ...theirs.map(m => m.handle)];
  const ours = db.prepare(`
    SELECT message_id AS handle, body AS text, sent_at AS at, 'reason' AS "from", id AS seq
      FROM outbox
     WHERE conversation_id = ? AND state = 'sent' AND message_id IS NOT NULL AND to_owner = 1
       AND reply_to COLLATE NOCASE IN (${under.map(() => "?").join(",")})`).all(conversationId, ...under);
  const skip = String(except ?? "").toLowerCase();
  return [...theirs, ...ours]
    .filter(m => !skip || String(m.handle).toLowerCase() !== skip)
    .sort((a, b) => (a.at - b.at) || (a.seq - b.seq))
    .slice(-limit);
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

// ---------- a tapback waiting on words ----------
/**
 * A tapback the model asked for on a turn where they had actually asked something.
 *
 * It is parked rather than sent, because a tapback on a question is not an answer: somebody who
 * asked "can you get us a table" and got a ❤️ has been acknowledged and ignored at the same time.
 * Parked on the row rather than in memory for the same reason everything else here is — the turn
 * can crash between the tool and the reply, and a reaction that fires on its own afterwards would
 * be the exact thing this prevents.
 */
export function holdReaction(conversationId, reaction) {
  db.prepare("UPDATE threads SET held_reaction = ? WHERE conversation_id = ?").run(reaction ?? null, conversationId);
}

/** Read the parked tapback and clear it, so it rides on exactly one message or on none. */
export function takeHeldReaction(conversationId) {
  const row = db.prepare("SELECT held_reaction FROM threads WHERE conversation_id = ?").get(conversationId);
  if (!row?.held_reaction) return null;
  holdReaction(conversationId, null);
  return row.held_reaction;
}

// ---------- an effect on the reply this turn is about to write ----------
/**
 * Mark this turn's reply as a moment. Null takes the mark away.
 *
 * The same shape as setReplyTarget, and for the same reason: the reply itself is not written by a
 * tool, so anything that has to travel WITH it has to be left somewhere the runtime reads at the
 * moment of sending. On the row rather than in memory so a redeploy mid-turn loses an animation
 * rather than leaving one armed for whatever the next reply happens to be.
 */
export function setPendingStyle(conversationId, style) {
  db.prepare("UPDATE threads SET pending_style = ? WHERE conversation_id = ?").run(style ?? null, conversationId);
}

/** Read the mark and clear it, so it is spent on exactly one message. */
export function takePendingStyle(conversationId) {
  const row = db.prepare("SELECT pending_style FROM threads WHERE conversation_id = ?").get(conversationId);
  if (!row?.pending_style) return null;
  setPendingStyle(conversationId, null);
  return row.pending_style;
}

/**
 * When this conversation last had a message queued with a screen effect on it, or null.
 *
 * Read off the outbox rather than counted in memory, which is what makes "one effect an hour"
 * survive a restart: the row carrying the effect IS the record of it. An effect that was queued and
 * then failed to send still counts, deliberately — the limit exists to keep effects rare, and the
 * conservative direction for a rare thing is to count the attempt.
 */
export function lastEffectAt(conversationId) {
  const row = db.prepare(
    "SELECT MAX(created_at) AS at FROM outbox WHERE conversation_id = ? AND send_style IS NOT NULL AND send_style != ''",
  ).get(conversationId);
  return row?.at ?? null;
}

/**
 * Where the outbox stood, so a turn can tell its own messages from the ones that were already in
 * the thread when it started. Turns for one conversation run one at a time, so anything queued for
 * it after this mark was queued by the turn that took the mark.
 */
export function outboxMark() {
  return db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM outbox").get().id;
}

/** Has this conversation been sent a pinned message since the mark? */
export function pinnedSince(conversationId, mark) {
  return !!db.prepare("SELECT 1 FROM outbox WHERE conversation_id = ? AND id > ? AND reply_to IS NOT NULL AND to_owner = 1 LIMIT 1").get(conversationId, mark);
}

/** How many messages this conversation has been handed to the outbox since the mark, in any state. */
export function sentSince(conversationId, mark) {
  return db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE conversation_id = ? AND id > ?").get(conversationId, mark).n;
}

/**
 * The words this conversation's own person has been handed since the mark, oldest first: every
 * owner-bound row with a body that has not been given up on. Queued rows count — they are on their
 * way, and a failure is told separately (undeliveredFor). Media with no words on it is skipped.
 */
export function ownerTextsSince(conversationId, mark) {
  return db.prepare(`SELECT id, body FROM outbox WHERE conversation_id = ? AND id > ? AND to_owner = 1
    AND state != 'failed' AND TRIM(pt(body)) != '' ORDER BY id`).all(conversationId, mark);
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
export function claimInbound({ channel, externalId, conversationId, text = null, replyTo = null, threadRoot = null }) {
  try {
    db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at, text, reply_to, thread_root) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(channel, externalId, conversationId, clock.now(), text ? seal2(conversationId, String(text)) : null,
        replyTo ? String(replyTo) : null, threadRoot ? String(threadRoot) : null);
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
    .run(channel, baseHandle, partIndex, conversationId, seal2(conversationId, text), JSON.stringify(urls), JSON.stringify(attachments), clock.now());
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

// ---------- what somebody sent that was not words, and what was got out of it ----------

/**
 * Write down one item that arrived — a photo, a voice note, a file, a link — before anything has
 * processed it. Returns the row, whose `id` is how every later update names it.
 *
 * A redelivered webhook is the same item, so (channel, event id, ordinal) overwrites in place and
 * keeps whatever coverage was already recorded: the provider sending the same photo twice must not
 * reset a photo Reason has already looked at back to `waiting`.
 */
export function recordMedia({ conversationId, channel, externalId, baseHandle = "", partIndex = 0, ordinal, kind, filename = "", url = "", coverage = "waiting", detail = "" }) {
  const now = clock.now();
  db.prepare(`INSERT INTO media_items
    (conversation_id, channel, external_id, base_handle, part_index, ordinal, kind, filename, url, coverage, detail, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel, external_id, ordinal) DO UPDATE SET
      conversation_id = excluded.conversation_id, base_handle = excluded.base_handle,
      part_index = excluded.part_index, kind = excluded.kind,
      filename = excluded.filename, url = excluded.url`)
    .run(conversationId, channel, String(externalId), baseHandle, partIndex, ordinal, kind, filename, url, coverage, detail, now);
  return db.prepare("SELECT * FROM media_items WHERE channel = ? AND external_id = ? AND ordinal = ?")
    .get(channel, String(externalId), ordinal);
}

/** What was actually got out of one item. 'detail' is the words a refusal is said in. */
export function coverMedia(id, { coverage, detail = "", bytes = null, seconds = null, transcript = null }) {
  // COALESCE on the three facts about the file, so a later update does not erase an earlier one:
  // `processing` is written before a transcriber is called and the real coverage after it, and
  // what was measured on the way past should survive that.
  db.prepare(`UPDATE media_items SET coverage = ?, detail = ?,
    bytes = COALESCE(?, bytes), seconds = COALESCE(?, seconds), transcript = COALESCE(?, transcript),
    reviewed_at = ? WHERE id = ?`)
    .run(coverage, String(detail ?? ""), bytes, seconds, transcript, clock.now(), id);
  return db.prepare("SELECT * FROM media_items WHERE id = ?").get(id);
}

/** One item by id, in this conversation only — which is what makes a transcript readable later. */
export function mediaItem(conversationId, id) {
  return db.prepare("SELECT * FROM media_items WHERE conversation_id = ? AND id = ?").get(conversationId, Number(id)) ?? null;
}

/**
 * The most recent item in this conversation at a URL, so a page or a video that has just been read
 * can be joined back to the link somebody actually sent. Scoped to the conversation, which is what
 * stops one person's link being marked read by another's lookup.
 */
export function mediaByUrl(conversationId, url) {
  return db.prepare("SELECT * FROM media_items WHERE conversation_id = ? AND url = ? ORDER BY id DESC LIMIT 1")
    .get(conversationId, String(url ?? "")) ?? null;
}

/** Everything in this conversation, newest message first, with the items of one message together. */
export function mediaFor(conversationId, { limit = 40, kinds = null } = {}) {
  const where = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
  return db.prepare(`SELECT * FROM media_items WHERE conversation_id = ?${where}
    ORDER BY id DESC LIMIT ?`).all(conversationId, ...(kinds ?? []), limit);
}

/** Every item that came in on one message, in the order they were attached. */
export function mediaOfMessage(conversationId, baseHandle) {
  return db.prepare("SELECT * FROM media_items WHERE conversation_id = ? AND base_handle = ? ORDER BY part_index, ordinal")
    .all(conversationId, String(baseHandle ?? ""));
}

/** Store what the model described in a photo, after the turn. */
export function describeMedia(id, description, { from = "" } = {}) {
  db.prepare("UPDATE media_items SET description = ?, description_from = ? WHERE id = ?").run(String(description ?? ""), String(from ?? ""), id);
}

/** Recently-viewed photos with descriptions, for turn context. */
export function recentDescribedMedia(conversationId, { since, limit = 10, kinds = ["image"] } = {}) {
  const where = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
  return db.prepare(`SELECT * FROM media_items WHERE conversation_id = ? AND coverage = 'looked'
    AND description != '' AND at >= ?${where} ORDER BY id DESC LIMIT ?`)
    .all(conversationId, since, ...(kinds ?? []), limit);
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
  let deadlineAt = firstArrival + maxMs;
  let readyAt = Math.min(now + quietMs, deadlineAt);
  // Texts already waiting out an outage (reholdInbound) are waiting for the model, not for the
  // rest of a thought: a new text joins their wait rather than pulling them forward into a turn
  // that would only fail again.
  const down = db.prepare("SELECT MAX(ready_at) AS at FROM pending_inbound WHERE conversation_id = ? AND down_since IS NOT NULL").get(conversationId)?.at ?? null;
  const joinedOutage = down !== null && down > readyAt;
  if (joinedOutage) {
    readyAt = down;
    deadlineAt = Math.max(deadlineAt, down);
  }

  db.prepare(`INSERT INTO pending_inbound
      (conversation_id, channel, address, chat_id, external_id, text, attachments, service, is_operator, arrived_at, ready_at, deadline_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, channel, address, chatId, externalId, seal2(conversationId, text), JSON.stringify(attachments), service, isOperator ? 1 : 0, now, readyAt, deadlineAt);
  // Everything held for this conversation now shares one window, so "is it due" is one comparison
  // wherever it is asked from — the waiting request, the sweep, or /health.
  db.prepare("UPDATE pending_inbound SET ready_at = ?, deadline_at = ? WHERE conversation_id = ?")
    .run(readyAt, deadlineAt, conversationId);
  return { readyAt, deadlineAt, held: countPendingInbound(conversationId), down: joinedOutage };
}

/**
 * Put texts a drain took back, to be run once the model is up again (src/down.js).
 *
 * The rows go back as they were — same handles, same arrival order — with one more on their
 * re-hold count and the outage's start kept on them, so the turn that finally runs can say how
 * long they waited. `readyAt` is when to try again; it is the deadline too, because nothing
 * about a burst applies to a wait for the model.
 */
export function reholdInbound(rows, { readyAt, downSince }) {
  const ins = db.prepare(`INSERT INTO pending_inbound
      (conversation_id, channel, address, chat_id, external_id, text, attachments, service, is_operator, arrived_at, ready_at, deadline_at, held_times, down_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    ins.run(
      r.conversation_id, r.channel, r.address, r.chat_id ?? null, r.external_id, seal2(r.conversation_id, r.text),
      JSON.stringify(r.attachments ?? []), r.service ?? null, r.is_operator ? 1 : 0, r.arrived_at,
      readyAt, readyAt, (r.held_times ?? 0) + 1, r.down_since ?? downSince,
    );
  }
  return { readyAt, held: rows.length ? countPendingInbound(rows[0].conversation_id) : 0 };
}

/** When this conversation's held messages may run, or null when it is holding none. */
export function pendingReadyAt(conversationId) {
  const r = db.prepare("SELECT MIN(ready_at) AS at FROM pending_inbound WHERE conversation_id = ?").get(conversationId);
  return r?.at ?? null;
}

/** The newest message this conversation is holding, or null. Read only — nothing is claimed. */
/** One held message by its handle, without taking it (the mid-turn read looks before it takes). */
export function pendingByHandle(conversationId, externalId) {
  return db.prepare("SELECT * FROM pending_inbound WHERE conversation_id = ? AND external_id = ? ORDER BY id LIMIT 1").get(conversationId, externalId) ?? null;
}

export function lastPendingInbound(conversationId) {
  return db.prepare("SELECT * FROM pending_inbound WHERE conversation_id = ? ORDER BY arrived_at DESC, id DESC LIMIT 1").get(conversationId) ?? null;
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
  const all = db.prepare("SELECT * FROM pending_inbound WHERE conversation_id = ? ORDER BY arrived_at, id").all(conversationId);
  if (!all.length) return [];
  // One turn is one chat (owner 10-27): a Web-only chat's messages are never answered in the same
  // turn as the shared thread's, or another Web chat's. The oldest chat goes first; the rest stay
  // held, and the same wait (or the sweep) drains them next.
  const key = (r) => (r.channel === "web" ? webChatOf(r.chat_id) ?? "" : "");
  const first = key(all[0]);
  const rows = all.filter(r => key(r) === first);
  const del = db.prepare("DELETE FROM pending_inbound WHERE id = ?");
  for (const r of rows) del.run(r.id);
  return rows.map(r => ({ ...r, attachments: safeJson(r.attachments, []) }));
}

/** What is waiting right now, for /health. */
export function pendingInboundSummary(now = clock.now()) {
  return db.prepare(`SELECT conversation_id, MIN(channel) AS channel, COUNT(*) AS messages, MIN(ready_at) AS ready_at, MIN(deadline_at) AS deadline_at
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
export function enqueueOutbound({ idemKey, conversationId, channel, address, chatId = null, body, media = null, sendStyle = null, replyTo = null, afterId = null, toOwner = false, maxAttempts = 5 }) {
  const existing = db.prepare("SELECT * FROM outbox WHERE idem_key = ?").get(idemKey);
  if (existing) return { fresh: false, row: rowToOut(existing) };
  const now = clock.now();
  const answers = turnlink.answeringFor(conversationId, address);
  const r = db.prepare(`INSERT INTO outbox
    (idem_key, conversation_id, channel, address, chat_id, body, media, send_style, reply_to, after_id, state, max_attempts, next_attempt_at, to_owner, created_at, updated_at, answers_handle)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`)
    .run(idemKey, conversationId, channel, seal2(conversationId, address), chatId, seal2(conversationId, String(body ?? "")),
      media ? JSON.stringify(media) : null, sendStyle, replyTo, afterId, maxAttempts, now, toOwner ? 1 : 0, now, now, answers);
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

// REASON_DELIVERY_GATED (src/outbox.js noteDelivery): what the carrier said AFTER taking a message.
// `sent` is "the provider accepted it"; delivery_status is its later word (SENT, DELIVERED, ERROR).
addColumnIfMissing("outbox", "delivery_status", "TEXT");
addColumnIfMissing("outbox", "delivered_at", "INTEGER");

/** The row the provider is talking about, by the handle it gave back when the message was accepted. */
export function outboundByMessageId(channel, messageId) {
  const id = String(messageId ?? "").trim();
  if (!id) return null;
  return rowToOut(db.prepare("SELECT * FROM outbox WHERE channel = ? AND message_id = ? ORDER BY id DESC LIMIT 1").get(channel, id));
}

/** The carrier's later word on a sent row (named with its person, so a wrong handle changes nobody else's row). A delivered one gets its stamp; any word is kept. */
export function markOutboundDelivery(id, { conversationId, status, delivered = false }) {
  const now = clock.now();
  db.prepare(`UPDATE outbox SET delivery_status = ?, delivered_at = CASE WHEN ? THEN ? ELSE delivered_at END, updated_at = ? WHERE id = ? AND conversation_id = ?`)
    .run(String(status ?? ""), delivered ? 1 : 0, now, now, id, conversationId);
  return getOutbound(id);
}

/** It went. */
export function markOutboundSent(id, { messageId = null } = {}) {
  const now = clock.now();
  db.prepare(`UPDATE outbox SET state = 'sent', message_id = ?, sent_at = ?, next_attempt_at = NULL,
    last_error = '', updated_at = ? WHERE id = ?`).run(messageId, now, now, id);
  const row = getOutbound(id);
  // The moment a message really went is the moment it is history (src/web.js). Not when it was
  // drafted: a reply the outbox never managed to send is not something the person was told.
  try { historyFromOutbound(row); } catch { /* history is never allowed to cost a send */ }
  return row;
}

/**
 * It was never going to be words for anybody: once the silence marker came off there was nothing
 * left (src/plain.js withoutNoReply). Not `failed` — nothing went wrong, so nobody is told — and
 * not `sent`, so it is never history. Anything queued behind it still goes (dueOutbound).
 */
export function markOutboundSkipped(id) {
  const now = clock.now();
  db.prepare(`UPDATE outbox SET state = 'skipped', next_attempt_at = NULL, last_error = 'only NO_REPLY: nothing to send',
    updated_at = ? WHERE id = ?`).run(now, id);
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

/**
 * It is never going — and nor is anything that was queued to follow it.
 *
 * The cascade is the point. A link leaves as two messages and the second one is only an
 * explanation of the first: a summary of a link that never arrived is a message about nothing,
 * and sending it would be the kind of half-thing that reads as a bug. So the chain dies with its
 * head, with its own reason, and both rows go through the "somebody is always told" machinery.
 */
export function markOutboundFailed(id, { error, errorKey = null, errorCode = null }) {
  const now = clock.now();
  db.prepare(`UPDATE outbox SET state = 'failed', next_attempt_at = NULL, failed_at = ?,
    last_error = ?, last_error_key = ?, last_error_code = ?, updated_at = ? WHERE id = ?`)
    .run(now, String(error ?? ""), errorKey, errorCode === null ? null : String(errorCode), now, id);
  for (const r of db.prepare("SELECT id FROM outbox WHERE after_id = ? AND state IN ('queued','unknown')").all(id)) {
    // The head's key travels with it: a follow-up dead because its head was refused for the person's
    // own reasons (opted out, never texted the line) is that same refusal, not a fault of Reason's.
    markOutboundFailed(r.id, { error: `the message it goes with never arrived, so this was not sent on its own: ${String(error ?? "")}`, errorKey, errorCode });
  }
  return getOutbound(id);
}

/**
 * A picture that cannot go, turned into its own words on the same row (src/outbox.js attempt): the
 * file comes off, the body becomes the line, the attempts start over, and it is due now. Same id, so
 * whatever is chained behind it still waits for it.
 */
export function outboundAsText(id, text) {
  const row = db.prepare("SELECT conversation_id FROM outbox WHERE id = ?").get(id);
  if (!row) return null;
  db.prepare(`UPDATE outbox SET state = 'queued', media = NULL, body = ?, attempts = 0, next_attempt_at = ?, updated_at = ? WHERE id = ? AND conversation_id = ?`)
    .run(seal2(row.conversation_id, String(text ?? "")), clock.now(), clock.now(), id, row.conversation_id);
  return getOutbound(id);
}

/**
 * A carousel that cannot go, turned into its pictures (src/outbox.js attempt): this row becomes the
 * first picture, a row for each of the others is chained after it, and whatever waited on this row
 * now waits on the last of them. One transaction. Returns the rows' ids, in order.
 */
export function outboundCarouselToPictures(id, pictures) {
  const conversationId = db.prepare("SELECT conversation_id FROM outbox WHERE id = ?").get(id)?.conversation_id;
  const row = conversationId ? db.prepare("SELECT * FROM outbox WHERE id = ? AND conversation_id = ?").get(id, conversationId) : null;
  if (!row || !pictures?.length) return [];
  const conv = row.conversation_id;
  const now = clock.now();
  const ids = [id];
  atomically(() => {
    db.prepare(`UPDATE outbox SET state = 'queued', media = ?, body = ?, attempts = 0, next_attempt_at = ?, updated_at = ? WHERE id = ? AND conversation_id = ?`)
      .run(JSON.stringify(pictures[0]), seal2(conv, ""), now, now, id, conv);
    let previous = id;
    for (const [k, p] of pictures.slice(1).entries()) {
      const r = db.prepare(`INSERT OR IGNORE INTO outbox
        (idem_key, conversation_id, channel, address, chat_id, body, media, send_style, reply_to, after_id, state, max_attempts, next_attempt_at, to_owner, created_at, updated_at)
        SELECT ?, conversation_id, channel, address, chat_id, ?, ?, NULL, NULL, ?, 'queued', max_attempts, ?, to_owner, ?, ? FROM outbox WHERE id = ? AND conversation_id = ?`)
        .run(`${row.idem_key}#p${k + 2}`, seal2(conv, ""), JSON.stringify(p), previous, now, now, now, id, conv);
      previous = r.changes ? Number(r.lastInsertRowid) : db.prepare("SELECT id FROM outbox WHERE idem_key = ? AND conversation_id = ?").get(`${row.idem_key}#p${k + 2}`, conv).id;
      ids.push(previous);
    }
    db.prepare(`UPDATE outbox SET after_id = ? WHERE after_id = ? AND conversation_id = ? AND id NOT IN (${ids.map(() => "?").join(",")})`)
      .run(previous, id, conv, ...ids);
  });
  return ids;
}

/** Nobody knows whether it arrived. Set only by the restart sweep. */
export function markOutboundUnknown(id, { error = "", nextAt = null } = {}) {
  const now = clock.now();
  db.prepare(`UPDATE outbox SET state = 'unknown', next_attempt_at = ?, last_error = ?, updated_at = ?
    WHERE id = ?`).run(nextAt, String(error ?? ""), now, id);
  return getOutbound(id);
}

/**
 * Rows wanting an attempt now: queued ones that are due, and interrupted ones wanting a question.
 *
 * A row with an `after_id` is held back until the one it follows has actually been sent. That is
 * what keeps a link and the words about it in that order when the first attempt at the link
 * failed and the retry comes round minutes later; without it the sweep would send the summary
 * first, because it is the one that is due.
 */
export function dueOutbound(now = clock.now(), { limit = 50 } = {}) {
  return db.prepare(`SELECT * FROM outbox AS o
    WHERE o.state IN ('queued','unknown') AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
      AND (o.after_id IS NULL
           OR EXISTS (SELECT 1 FROM outbox AS p WHERE p.id = o.after_id AND p.state IN ('sent','skipped')))
    ORDER BY o.id ASC LIMIT ?`).all(now, limit).map(rowToOut);
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

/**
 * A person's OWN text that the carrier accepted and later reported undelivered (REASON_DELIVERY_GATED,
 * src/outbox.js noteDelivery), not yet told. The sweep says it in one line rather than waiting for
 * their next turn.
 */
export function ownUndeliveredUntold() {
  return db.prepare(`SELECT * FROM outbox WHERE state = 'failed' AND to_owner = 1 AND told_at IS NULL
    AND last_error_key = 'DELIVERY_ERROR' ORDER BY id ASC`).all().map(rowToOut);
}

/** Said once. Returns false when somebody else got there first. */
export function markUndeliveredTold(id) {
  const r = db.prepare("UPDATE outbox SET told_at = ?, updated_at = ? WHERE id = ? AND told_at IS NULL")
    .run(clock.now(), clock.now(), id);
  return r.changes === 1;
}

/** Put back as untold: the turn that claimed them was thrown away unheard (the harm screen refused it). */
export function unmarkUndeliveredTold(ids = []) {
  const st = db.prepare("UPDATE outbox SET told_at = NULL, updated_at = ? WHERE id = ?");
  for (const id of ids) st.run(clock.now(), id);
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

/**
 * Every row whose idempotency key starts with `prefix`, oldest first.
 *
 * How a caller that names its own keys asks "did I already hand this over?" before doing the work
 * again. A prefix rather than one key because one message can be several rows: a reply with a link
 * in it is `key#1`, `key#2` (sendSequence), and a summary whose recording would not go is retried
 * as text under `key:text` (src/deliver.js).
 */
export function outboundUnder(prefix) {
  const p = String(prefix);
  return db.prepare("SELECT * FROM outbox WHERE substr(idem_key, 1, ?) = ? ORDER BY id").all(p.length, p).map(rowToOut);
}

/** For /health and for a test that wants to see the whole state machine at once. */
export function outboxCounts() {
  const rows = db.prepare("SELECT state, COUNT(*) AS n FROM outbox GROUP BY state").all();
  return Object.fromEntries(rows.map(r => [r.state, r.n]));
}

// ---------- the undo window ----------
//
// Rows only. What the window is, when it applies and what Reason says about it are src/undo.js;
// this is the state machine, so it is provable with no model, no channel and no clock but the fake
// one. Every transition out of 'held' is a compare-and-set, which is what makes "at most once"
// a property of the table rather than of whoever happens to call it.

function rowToHold(r) {
  if (!r) return null;
  return { ...r, input: JSON.parse(r.input), result: r.result ? JSON.parse(r.result) : null };
}

/** Park one action for its window. Returns the row that will either happen or be stopped. */
export function holdAction({ conversationId, action, input, kind, what, toWhom, doing, idemKey, holdMs, dueAt, confirmationId = null, permissionId = null }) {
  const now = clock.now();
  const existing = db.prepare("SELECT * FROM held_actions WHERE idem_key = ?").get(idemKey);
  if (existing) return { fresh: false, row: rowToHold(existing) };
  const r = db.prepare(`INSERT INTO held_actions
    (conversation_id, action, input, kind, what, to_whom, doing, idem_key, hold_ms, due_at, state, confirmation_id, permission_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)`)
    .run(conversationId, action, JSON.stringify(input ?? {}), kind, String(what ?? ""), String(toWhom ?? ""),
      String(doing ?? ""), idemKey, holdMs, dueAt, confirmationId, permissionId, now, now);
  return { fresh: true, row: rowToHold(db.prepare("SELECT * FROM held_actions WHERE id = ?").get(r.lastInsertRowid)) };
}

export function getHeldAction(id) {
  return rowToHold(db.prepare("SELECT * FROM held_actions WHERE id = ?").get(id));
}

/**
 * What is still inside its window in this conversation, newest first.
 *
 * Newest first because that is the default an un-named "undo" means: the thing they just watched
 * Reason say it was about to do.
 */
export function liveHolds(conversationId) {
  return db.prepare("SELECT * FROM held_actions WHERE conversation_id = ? AND state = 'held' ORDER BY id DESC")
    .all(conversationId).map(rowToHold);
}

/** Holds of every state from the last `sinceMs`, newest first — what the activity page reads. */
export function recentHolds(conversationId, { sinceMs = 24 * 60 * 60 * 1000, limit = 20, now = clock.now() } = {}) {
  return db.prepare(`SELECT * FROM held_actions WHERE conversation_id = ? AND updated_at >= ?
    ORDER BY id DESC LIMIT ?`).all(conversationId, now - sinceMs, limit).map(rowToHold);
}

/** Windows that have run out. */
export function dueHolds(now = clock.now(), { limit = 25 } = {}) {
  return db.prepare("SELECT * FROM held_actions WHERE state = 'held' AND due_at <= ? ORDER BY id ASC LIMIT ?")
    .all(now, limit).map(rowToHold);
}

/**
 * Take one row out of the window and into the doing of it: 'held' → 'going'.
 *
 * The compare-and-set is the whole of "at most once". Two overlapping sweeps both reach a due row;
 * exactly one of them changes it and the other gets null. It is also what makes a late undo honest
 * rather than racy — once this has run, stopHeldAction can no longer win.
 */
export function claimHold(id) {
  const now = clock.now();
  const r = db.prepare("UPDATE held_actions SET state = 'going', released_at = ?, updated_at = ? WHERE id = ? AND state = 'held'")
    .run(now, now, id);
  return r.changes === 1 ? getHeldAction(id) : null;
}

/** It happened. */
export function markHoldSent(id, result = null) {
  const now = clock.now();
  db.prepare("UPDATE held_actions SET state = 'sent', result = ?, last_error = '', updated_at = ? WHERE id = ?")
    .run(result ? JSON.stringify(result) : null, now, id);
  return getHeldAction(id);
}

/** The window ran out and the thing itself did not work. */
export function markHoldFailed(id, { error = "", result = null } = {}) {
  const now = clock.now();
  db.prepare("UPDATE held_actions SET state = 'failed', last_error = ?, result = ?, updated_at = ? WHERE id = ?")
    .run(String(error ?? ""), result ? JSON.stringify(result) : null, now, id);
  return getHeldAction(id);
}

/** The process stopped mid-release, so whether it happened is not known. Never retried. */
export function markHoldUnknown(id, { error = "" } = {}) {
  const now = clock.now();
  db.prepare("UPDATE held_actions SET state = 'unknown', last_error = ?, updated_at = ? WHERE id = ?")
    .run(String(error ?? ""), now, id);
  return getHeldAction(id);
}

/**
 * They said stop, in time: 'held' → 'stopped'.
 *
 * Returns null when the row is not theirs, does not exist, or has already left the window — and
 * that last one is the case this is really for. "Stopped, nothing went to Marta" must never be
 * said about something that went to Marta eight seconds ago, so the honest answer comes from the
 * row refusing the change rather than from anybody reading a clock.
 */
export function stopHeldAction(conversationId, id) {
  const now = clock.now();
  const r = db.prepare("UPDATE held_actions SET state = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ? AND conversation_id = ? AND state = 'held'")
    .run(now, now, id, conversationId);
  return r.changes === 1 ? getHeldAction(id) : null;
}

/** Rows that were mid-release when the last process stopped. */
export function strandedHolds() {
  return db.prepare("SELECT * FROM held_actions WHERE state = 'going' ORDER BY id ASC").all().map(rowToHold);
}

/** Holds that died on release and whose owner has not been told yet. */
export function untoldHoldFailures() {
  return db.prepare(`SELECT * FROM held_actions WHERE state IN ('failed','unknown') AND told_at IS NULL
    ORDER BY id ASC`).all().map(rowToHold);
}

/** Said once. Returns false when somebody else got there first. */
export function markHoldTold(id) {
  const now = clock.now();
  const r = db.prepare("UPDATE held_actions SET told_at = ?, updated_at = ? WHERE id = ? AND told_at IS NULL").run(now, now, id);
  return r.changes === 1;
}

/**
 * How long this person wants things held, overall and per kind.
 *
 * Nulls all the way down rather than defaults, because "they asked for a minute on email" and
 * "nobody has ever changed this" are different facts and only one of them is worth saying back.
 */
export function undoPrefs(conversationId) {
  const row = db.prepare("SELECT undo_seconds, undo_by_kind FROM accounts WHERE conversation_id = ?").get(conversationId);
  let byKind = {};
  try { byKind = row?.undo_by_kind ? JSON.parse(row.undo_by_kind) : {}; } catch { byKind = {}; }
  return { seconds: row?.undo_seconds ?? null, byKind };
}

/**
 * `kind` null sets the overall window; a kind sets only that one.
 *
 * `saved` is false when there is no account behind this conversation, and it is on the result
 * rather than thrown because the caller has something honest to say about it. The row is NOT
 * invented to hang a preference off: accounts is keyed on a real channel and address with a
 * uniqueness rule on the pair, so a blank one would be a person who does not exist. The failure
 * worth catching here is the quiet one — an UPDATE matching nothing, Reason saying "no undo window"
 * in a conversation where every send still waits its thirty seconds.
 */
export function setUndoPrefs(conversationId, { seconds, kind = null }) {
  const current = undoPrefs(conversationId);
  const r = !kind
    ? db.prepare("UPDATE accounts SET undo_seconds = ? WHERE conversation_id = ?").run(seconds, conversationId)
    : db.prepare("UPDATE accounts SET undo_by_kind = ? WHERE conversation_id = ?")
      .run(JSON.stringify({ ...current.byKind, [kind]: seconds }), conversationId);
  return { ...undoPrefs(conversationId), saved: r.changes === 1 };
}

// ---------- calls ----------
/**
 * How many characters of a call's own webhook address are secret. Thirty-two of the page alphabet
 * is about 190 bits; unlike a page link this is never texted to anybody, so it is sized to be
 * unguessable rather than to fit in a bubble.
 */
export const CALL_WEBHOOK_TOKEN_LENGTH = 32;

export function createCall(conversationId, {
  provider, toNumber, isOwner, goal, facts, confirmationId = null, announcement = "",
  // Outbound unless a caller says otherwise. The one caller that says otherwise is the inbound
  // voice webhook (`inboundTwiml` in src/calls/gptlive.js), which makes the row while the phone is still
  // ringing so that the turn behind the voice has something to be scoped by.
  direction = "out",
  // An inbound call has an id from the platform before Reason knows anything else about it, and
  // that id is what the call can be looked up by.
  externalId = null,
  // An inbound call reached the state it is in by being answered, not by being dialled.
  state = "placing",
  // The job this call is a step of, when it is one.
  taskId = null,
  // The timer whose firing placed this call, when it was a scheduled one ("call me at 7"). Written
  // with the row, not after it, because it is what stops a retry of that timer ringing twice.
  timerId = null,
} = {}) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO calls
    (conversation_id, provider, external_id, to_number, is_owner, goal, facts, state, direction,
     confirmation_id, announcement, webhook_token, task_id, timer_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, provider, externalId, seal2(conversationId, toNumber), isOwner ? 1 : 0, seal2(conversationId, goal), seal2(conversationId, JSON.stringify(facts ?? [])),
         state, direction === "in" ? "in" : "out", confirmationId,
         announcement, linkToken(CALL_WEBHOOK_TOKEN_LENGTH), taskId, timerId, now, now);
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

/**
 * The call a provider's own id names, across every conversation.
 *
 * Unscoped for the same reason `callByWebhookToken` is: a provider that pushes something back names
 * the call by ITS id, and which person's Reason that call belongs to is the answer rather than part
 * of the question. The provider name goes in as well, so two providers' id spaces cannot collide.
 *
 * The newest row wins. An id a provider reuses is not a thing to design around, but a stale row
 * from a crashed test run should never outrank the call that is happening now.
 */
export function callByExternalId(provider, externalId) {
  const id = String(externalId ?? "").trim();
  if (!id) return null;
  const r = db.prepare("SELECT * FROM calls WHERE provider = ? AND external_id = ? ORDER BY id DESC LIMIT 1")
    .get(String(provider ?? ""), id);
  return r ? { ...r, facts: JSON.parse(r.facts) } : null;
}

export function getCall(conversationId, id) {
  const r = db.prepare("SELECT * FROM calls WHERE id = ? AND conversation_id = ?").get(id, conversationId);
  return r ? { ...r, facts: JSON.parse(r.facts) } : null;
}

/** The lookups a call row carries, oldest first; [] for a row from before the column or a bad value. */
export function callLookups(row) {
  try {
    const list = JSON.parse(row?.lookups ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Add one tool run to a call's record. The newest 20 are kept — a phone turn pays for every token. */
export function addCallLookup(conversationId, id, entry) {
  const row = db.prepare("SELECT lookups FROM calls WHERE id = ? AND conversation_id = ?").get(id, conversationId);
  if (!row) return;
  const list = [...callLookups(row), entry].slice(-20);
  db.prepare("UPDATE calls SET lookups = ? WHERE id = ? AND conversation_id = ?").run(JSON.stringify(list), id, conversationId);
}

export function listCalls(conversationId, { limit = 20 } = {}) {
  return db.prepare("SELECT * FROM calls WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(conversationId, limit).map(r => ({ ...r, facts: JSON.parse(r.facts) }));
}

/**
 * Calls that still say they are going, started longer ago than any call could still be running.
 *
 * Every conversation's, because the thing that settles these is the sweep rather than somebody
 * asking about one. A row is settled by whichever of two paths finds out first — the provider's
 * post-call webhook, or `call_status` asking — and a call nobody ever asked about whose webhook
 * never arrived had no third path: four rows from 2026-10-12 still read `in_progress` five days
 * later. They are not a cosmetic problem. `pendingCallVerification` looks for a call with no
 * `ended_at`, `liveErrandCalls` counts these against the parallel limit, and "is a call live right
 * now?" is the question asked before restarting the service.
 */
export function lostCalls(startedBefore) {
  // One cut-off for every state, or two: a call nobody picked up (`placing`/`ringing`) is given up on
  // long before one somebody is talking on (`in_progress`) — see `callLostAfterMs` in tools.js.
  const { notAnsweredBefore, inProgressBefore } = typeof startedBefore === "object" && startedBefore
    ? startedBefore
    : { notAnsweredBefore: startedBefore, inProgressBefore: startedBefore };
  return db.prepare(
    `SELECT * FROM calls WHERE (state IN ('placing', 'ringing') AND created_at < ?)
      OR (state = 'in_progress' AND created_at < ?)
      ORDER BY id ASC`,
  ).all(notAnsweredBefore, inProgressBefore).map(r => ({ ...r, facts: JSON.parse(r.facts) }));
}

// ---------- errands: one request, several calls ----------

export function createErrand(conversationId, { goal, kind = "inquiry", questions = [], brief = {}, taskId = null } = {}) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO call_errands
    (conversation_id, goal, kind, questions, brief, task_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, String(goal ?? ""), kind === "booking" ? "booking" : "inquiry",
         JSON.stringify(questions ?? []), JSON.stringify(brief ?? {}), taskId, now, now);
  return getErrand(conversationId, Number(r.lastInsertRowid));
}

const errandRow = (r) => (r ? { ...r, questions: safeJson(r.questions, []), brief: safeJson(r.brief, {}) } : null);

export function getErrand(conversationId, id) {
  return errandRow(db.prepare("SELECT * FROM call_errands WHERE id = ? AND conversation_id = ?").get(id, conversationId));
}

export function listErrands(conversationId, { limit = 10, open = false } = {}) {
  const sql = open
    ? "SELECT * FROM call_errands WHERE conversation_id = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT ?"
    : "SELECT * FROM call_errands WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?";
  return db.prepare(sql).all(conversationId, limit).map(errandRow);
}

export function updateErrand(conversationId, id, fields) {
  const allowed = ["state", "decision", "committed_call_id", "closed_at", "questions", "brief", "kind", "goal"];
  const sets = ["updated_at = ?"];
  const args = [clock.now()];
  for (const k of allowed) {
    if (fields[k] === undefined) continue;
    sets.push(`${k} = ?`);
    args.push(k === "questions" || k === "brief" ? JSON.stringify(fields[k]) : fields[k]);
  }
  db.prepare(`UPDATE call_errands SET ${sets.join(", ")} WHERE id = ? AND conversation_id = ?`).run(...args, id, conversationId);
  return getErrand(conversationId, id);
}

/**
 * Claim the single booking slot on an errand, atomically.
 *
 * The `AND committed_call_id IS NULL` is the whole lock, and it is in SQL rather than in JavaScript on
 * purpose: two calls can be live at the same time by design, and "read the column, see it is empty,
 * write it" has a window between the read and the write in which both of them see empty. That window
 * is exactly how two places both get told yes, which is the failure the owner named. `changes` being 1
 * means this call won it; 0 means somebody else already has it.
 */
export function claimErrandBooking(conversationId, errandId, callId) {
  const r = db.prepare("UPDATE call_errands SET committed_call_id = ?, updated_at = ? WHERE id = ? AND conversation_id = ? AND committed_call_id IS NULL")
    .run(callId, clock.now(), errandId, conversationId);
  return r.changes === 1;
}

/** Every call made on this errand, oldest first, so a summary reads in the order it happened. */
export function errandCalls(conversationId, errandId) {
  return db.prepare("SELECT * FROM calls WHERE conversation_id = ? AND errand_id = ? ORDER BY id ASC")
    .all(conversationId, errandId).map(r => ({ ...r, facts: safeJson(r.facts, []) }));
}

/**
 * Is a call for this task on the line right now (Reason Web's Ongoing: "WORKING · CALLING NOW")?
 * Only one started in the last `withinMs`: a row whose end never arrived (see lostCalls) is not a
 * call that is ringing now.
 */
export function taskCallLive(conversationId, taskId, { now = clock.now(), withinMs = 2 * 60 * 60_000 } = {}) {
  return !!db.prepare("SELECT 1 FROM calls WHERE conversation_id = ? AND task_id = ? AND state IN ('placing','ringing','in_progress') AND created_at >= ? LIMIT 1")
    .get(conversationId, taskId, now - withinMs);
}

/**
 * The newest call to this number that is still placing, ringing or connected, from ANY conversation
 * (two turns, or two people, must never ring one phone twice at once). Rows older than `withinMs`
 * are a crashed call the lost-call sweep has not written off yet, not a ringing phone.
 */
export function liveCallTo(toNumber, { now = clock.now(), withinMs = 75 * 60_000 } = {}) {
  if (!toNumber) return null;
  const r = db.prepare("SELECT * FROM calls WHERE state IN ('placing','ringing','in_progress') AND created_at >= ? AND pt(to_number) = ? ORDER BY id DESC LIMIT 1")
    .get(now - withinMs, toNumber);
  return r ? { ...r, facts: safeJson(r.facts, []) } : null;
}

/** Calls on this errand that are still going, for the parallel limit. */
export function liveErrandCalls(conversationId, errandId) {
  return db.prepare("SELECT * FROM calls WHERE conversation_id = ? AND errand_id = ? AND state IN ('placing','ringing','in_progress')")
    .all(conversationId, errandId).map(r => ({ ...r, facts: safeJson(r.facts, []) }));
}

/** Every attempt at one number on one errand, for the retry limit and the no-second-voicemail rule. */
export function callsToNumber(conversationId, { errandId = null, toNumber = "" } = {}) {
  const sql = errandId
    ? "SELECT * FROM calls WHERE conversation_id = ? AND pt(to_number) = ? AND errand_id = ? ORDER BY id ASC"
    : "SELECT * FROM calls WHERE conversation_id = ? AND pt(to_number) = ? ORDER BY id ASC";
  const args = errandId ? [conversationId, toNumber, errandId] : [conversationId, toNumber];
  return db.prepare(sql).all(...args).map(r => ({ ...r, facts: safeJson(r.facts, []) }));
}

/**
 * Every call to or from this number since `since`, on anybody's conversation, oldest first. For a place
 * ringing back (src/calls/inbound.js): the errand it is returning may be any person's, not only the
 * operator's. Only ever read by number, for a call that number is making now.
 */
export function callsWithNumber({ toNumber = "", since = 0 } = {}) {
  return db.prepare("SELECT * FROM calls WHERE created_at >= ? AND pt(to_number) = ? ORDER BY id ASC")
    .all(since, toNumber).map(r => ({ ...r, facts: safeJson(r.facts, []) }));
}

// ---------- quotes ----------

const quoteRow = (r) => (r ? { ...r, included: safeJson(r.included, []), excluded: safeJson(r.excluded, []) } : null);

export function addQuote(conversationId, { errandId, callId, place = "", toNumber = "", priceCents = null,
  feesCents = null, totalCents = null, currency = "USD", firmness = "unknown", holdsUntil = "",
  earliest = "", included = [], excluded = [], saidBy = "", notes = "" } = {}) {
  const r = db.prepare(`INSERT INTO call_quotes
    (errand_id, call_id, conversation_id, place, to_number, price_cents, fees_cents, total_cents,
     currency, firmness, holds_until, earliest, included, excluded, said_by, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(errandId, callId, conversationId, place, seal2(conversationId, toNumber), priceCents, feesCents, totalCents,
         currency, firmness, holdsUntil, earliest, JSON.stringify(included ?? []),
         JSON.stringify(excluded ?? []), saidBy, notes, clock.now());
  return quoteRow(db.prepare("SELECT * FROM call_quotes WHERE id = ?").get(Number(r.lastInsertRowid)));
}

export function errandQuotes(conversationId, errandId) {
  return db.prepare("SELECT * FROM call_quotes WHERE conversation_id = ? AND errand_id = ? ORDER BY id ASC")
    .all(conversationId, errandId).map(quoteRow);
}

/** The quote one call produced, when it produced one. A call is allowed at most one; the latest wins. */
export function quoteForCall(conversationId, callId) {
  return quoteRow(db.prepare("SELECT * FROM call_quotes WHERE conversation_id = ? AND call_id = ? ORDER BY id DESC LIMIT 1")
    .get(conversationId, callId));
}

// ---------- commitments ----------

const commitRow = (r) => (r
  ? { ...r, terms: safeJson(r.terms, []), outside: safeJson(r.outside, []), readback: safeJson(r.readback, {}) }
  : null);

export function createCommitment(conversationId, { callId, errandId = null, what, totalCents = null,
  terms = [], state = "proposed", why = "", outside = [], readback = {} } = {}) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO call_commitments
    (conversation_id, call_id, errand_id, what, total_cents, terms, state, why, outside, readback, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, callId, errandId, String(what ?? ""), totalCents, JSON.stringify(terms ?? []),
         state, why, JSON.stringify(outside ?? []), JSON.stringify(readback ?? {}), now, now);
  return getCommitment(conversationId, Number(r.lastInsertRowid));
}

export function getCommitment(conversationId, id) {
  return commitRow(db.prepare("SELECT * FROM call_commitments WHERE id = ? AND conversation_id = ?").get(id, conversationId));
}

export function updateCommitment(conversationId, id, fields) {
  const allowed = ["state", "why", "reference", "asked_owner_at", "owner_said", "total_cents", "terms", "outside", "readback"];
  const sets = ["updated_at = ?"];
  const args = [clock.now()];
  for (const k of allowed) {
    if (fields[k] === undefined) continue;
    sets.push(`${k} = ?`);
    args.push(["terms", "outside", "readback"].includes(k) ? JSON.stringify(fields[k]) : fields[k]);
  }
  db.prepare(`UPDATE call_commitments SET ${sets.join(", ")} WHERE id = ? AND conversation_id = ?`).run(...args, id, conversationId);
  return getCommitment(conversationId, id);
}

export function callCommitments(conversationId, callId) {
  return db.prepare("SELECT * FROM call_commitments WHERE conversation_id = ? AND call_id = ? ORDER BY id ASC")
    .all(conversationId, callId).map(commitRow);
}

export function errandCommitments(conversationId, errandId) {
  return db.prepare("SELECT * FROM call_commitments WHERE conversation_id = ? AND errand_id = ? ORDER BY id ASC")
    .all(conversationId, errandId).map(commitRow);
}

/**
 * Anything already agreed at this number, whichever errand it was on.
 *
 * Deliberately NOT scoped to an errand: the question "did this already go through" is about the
 * number and the thing, and a redial that only checked its own errand would miss the booking made by
 * the call before the one that dropped.
 */
export function commitmentsAtNumber(conversationId, toNumber) {
  return db.prepare(`SELECT c.* FROM call_commitments c JOIN calls k ON k.id = c.call_id
    WHERE c.conversation_id = ? AND pt(k.to_number) = ? ORDER BY c.id ASC`)
    .all(conversationId, toNumber).map(commitRow);
}

/** Commitments waiting on the owner right now, across everything. What a yes or no gets applied to. */
export function pausedCommitments(conversationId) {
  return db.prepare("SELECT * FROM call_commitments WHERE conversation_id = ? AND state = 'paused_for_owner' ORDER BY id ASC")
    .all(conversationId).map(commitRow);
}

// ---------- "make this call for me", asked on a call (2026-10-07) ----------

const requestRow = (r) => (r ? { ...r, brief: JSON.parse(r.brief || "{}") } : null);

export const CALL_REQUEST_OPEN = ["preparing", "dialing", "waiting", "needs_your_word"];

export function createCallRequest(conversationId, {
  askedOnCallId, toNumber, name = "", goal, brief = {}, taskId = null, review = "", reviewHash = "",
}) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO call_requests
    (conversation_id, asked_on_call_id, task_id, to_number, name, goal, brief, state, review, review_hash, reviewed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?)`)
    .run(conversationId, askedOnCallId, taskId, seal2(conversationId, toNumber), name, goal, JSON.stringify(brief ?? {}),
         review, reviewHash, review ? now : null, now, now);
  return getCallRequest(conversationId, Number(r.lastInsertRowid));
}

export function getCallRequest(conversationId, id) {
  return requestRow(db.prepare("SELECT * FROM call_requests WHERE id = ? AND conversation_id = ?").get(id, conversationId));
}

/** The request an outgoing call was placed FOR, when it was placed for one. */
export function callRequestForCall(conversationId, placedCallId) {
  return requestRow(db.prepare("SELECT * FROM call_requests WHERE conversation_id = ? AND placed_call_id = ? ORDER BY id DESC LIMIT 1")
    .get(conversationId, placedCallId));
}

/** Everything still open, newest first; or only the ones to one number. */
export function openCallRequests(conversationId, { toNumber = null } = {}) {
  const marks = CALL_REQUEST_OPEN.map(() => "?").join(", ");
  const rows = toNumber
    ? db.prepare(`SELECT * FROM call_requests WHERE conversation_id = ? AND pt(to_number) = ? AND state IN (${marks}) ORDER BY id DESC`)
      .all(conversationId, toNumber, ...CALL_REQUEST_OPEN)
    : db.prepare(`SELECT * FROM call_requests WHERE conversation_id = ? AND state IN (${marks}) ORDER BY id DESC`)
      .all(conversationId, ...CALL_REQUEST_OPEN);
  return rows.map(requestRow);
}

export function updateCallRequest(conversationId, id, fields) {
  const allowed = [
    "state", "review", "review_hash", "reviewed_at", "authorized_at", "authorized_how",
    "confirmation_id", "placed_call_id", "result", "brief", "task_id",
  ];
  const sets = ["updated_at = ?"];
  const args = [clock.now()];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); args.push(k === "brief" ? JSON.stringify(fields[k]) : fields[k]); }
  }
  db.prepare(`UPDATE call_requests SET ${sets.join(", ")} WHERE id = ? AND conversation_id = ?`).run(...args, id, conversationId);
  return getCallRequest(conversationId, id);
}


export function updateCall(conversationId, id, fields) {
  const allowed = [
    "external_id", "state", "outcome", "summary", "transcript", "duration_s", "cost_cents",
    // Which voice really carried an owner call: GPT-Live's place() reports itself (src/calls/gptlive.js).
    "provider",
    // What a second call_place handed into this one while it rang or ran (tools.js, calls 66/67).
    "facts",
    "recording_state", "recording_file", "recording_format", "recording_seconds",
    "recording_bytes", "recording_sha256", "recording_why",
    "language", "language_announced",
    // What a real call is like (2026-10-07): waiting, who has heard the announcement, which keys were
    // pressed, what was read back, and what the call ACHIEVED as opposed to what the phone did.
    "hold_since", "hold_total_s", "hold_waits", "hold_budget_s", "hold_gave_up",
    "party_n", "parties_told", "menu_presses",
    "outcome_kind", "confirmation_ref", "confirmation_strength", "readback", "brief",
    "errand_id", "voicemail_left", "attempt", "told_at",
    // The 2026-10-07 addendum: the second check on an owner call, and what the call ran under.
    "verified_at", "verified_how", "verify_tries", "verify_sent_at", "verify_sent_after_msgs", "verify_deferred",
    "profile", "tts_model",
    "opening_waits", "machine_heard",
    // A GPT-Live third-party call names Reason in its disclosure (src/calls/gptlive.js lineAnnouncement).
    "announcement",
    // Why it ended and what the platform says it cost (the 2026-10-30 call audit).
    "end_reason", "end_detail", "cost_credits", "cost_raw",
    // The after-call steps (call 57, 2026-10-31): begun, finished, and how often a boot picked them up.
    "settle_started_at", "settled_at", "settle_resumes",
    // Pickup timing and the opener clip (src/calls/opener.js), and the one "nobody heard it" text.
    "first_audio_ms", "pickup_opener", "pickup_about", "unreached_told_at",
    // What was heard, turn by turn, with timing and input level (src/calls/gptlive.js turnLog).
    "turn_log",
  ];
  const sets = ["updated_at = ?"];
  const args = [clock.now()];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); args.push(restcrypt.sealCell("calls", k, conversationId, fields[k])); }
  }
  const ended = !!fields.state && !["placing", "ringing", "in_progress"].includes(fields.state);
  if (ended) {
    sets.push("ended_at = ?"); args.push(clock.now());
  }
  db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id = ? AND conversation_id = ?`).run(...args, id, conversationId);
  // Told when the outcome is written and again when the call ends (an outcome written mid-call is only
  // final — its hold and menu presses all in — once the line is down).
  if (fields.outcome_kind || ended) emitCompletion("call", { conversationId, id });
  return getCall(conversationId, id);
}

/**
 * An owner call on this conversation that texted a verification question and is still waiting for
 * the answer. Returns the row if one exists, null otherwise.
 *
 * This is what lets the text handler recognise "Yes" as an answer to the call's question rather
 * than as a standalone message about the last text. Without it the text side has no idea there is
 * a call waiting on a reply.
 */
export function pendingCallVerification(conversationId) {
  const r = db.prepare(
    `SELECT * FROM calls
      WHERE conversation_id = ? AND is_owner = 1
        AND verify_sent_at IS NOT NULL AND verified_at IS NULL
        AND ended_at IS NULL
      ORDER BY created_at DESC LIMIT 1`
  ).get(conversationId);
  return r ? { ...r, facts: JSON.parse(r.facts) } : null;
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

/**
 * Calls whose after-call steps began and never finished, ended since `since`, not yet picked up by a
 * boot. Only rows the new path stamped: an older call, or one that never reached the steps, is not one.
 */
export function callsToResumeSettle(since) {
  return db.prepare(
    `SELECT * FROM calls
      WHERE settle_started_at IS NOT NULL AND settled_at IS NULL AND settle_resumes = 0
        AND settle_started_at >= ? AND state NOT IN ('placing', 'ringing', 'in_progress')
      ORDER BY id ASC`,
  ).all(since).map(r => ({ ...r, facts: JSON.parse(r.facts) }));
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
  const calls = (conversationId ? db.prepare(sql).all(conversationId) : db.prepare(sql).all())
    .map(r => ({
      call_id: r.id, conversation_id: r.conversation_id, file: r.recording_file,
      format: r.recording_format, bytes: r.recording_bytes, sha256: r.recording_sha256,
    }));
  // A GPT-Live call from somebody with no account keeps its audio on its stranger_calls row
  // (src/strangercalls.js): theirs once matched to an account, everybody's in a whole-install wipe.
  let strangers = [];
  try {
    strangers = (conversationId
      ? db.prepare("SELECT id, matched_conversation_id, recording_path FROM stranger_calls WHERE recording_path IS NOT NULL AND matched_conversation_id = ? ORDER BY id ASC").all(conversationId)
      : db.prepare("SELECT id, matched_conversation_id, recording_path FROM stranger_calls WHERE recording_path IS NOT NULL ORDER BY id ASC").all())
      .map(r => ({ call_id: null, stranger_call_id: r.id, conversation_id: r.matched_conversation_id ?? null, file: r.recording_path, format: "wav", bytes: null, sha256: null }));
  } catch { /* no stranger_calls table in this process */ }
  return [...calls, ...strangers];
}

// ---------- watches ----------
export function createWatch(conversationId, { url = "", lookingFor, note = "", everyMs, planId = null, taskId = null, query = "", monitorId = null }) {
  const r = db.prepare(`INSERT INTO watches
    (conversation_id, url, looking_for, note, every_ms, plan_id, created_at, task_id, query, monitor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, url, lookingFor, note, everyMs, planId, clock.now(), taskId, query, monitorId);
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
/** The watch a Parallel monitor belongs to, for a webhook that has only the monitor's id. */
export function watchForMonitor(monitorId) {
  return db.prepare("SELECT * FROM watches WHERE monitor_id = ?").get(monitorId) ?? null;
}
/** A webhook said something happened: make the watch due now, so the next sweep reads the events. */
export function markWatchDue(id) {
  db.prepare("UPDATE watches SET last_checked_at = NULL WHERE id = ?").run(id);
}
export function noteWatchEvent(id, eventId) {
  db.prepare("UPDATE watches SET last_event_id = ? WHERE id = ?").run(eventId, id);
}

// ---------- parallel runs ----------
export function createParallelRun(conversationId, { kind, remoteId, researchId = null, taskId = null, objective = "" }) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO parallel_runs (conversation_id, kind, remote_id, research_id, task_id, objective, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(conversationId, kind, remoteId, researchId, taskId, objective, now, now);
  return getParallelRun(Number(r.lastInsertRowid));
}
export function getParallelRun(id) {
  return rowToParallelRun(db.prepare("SELECT * FROM parallel_runs WHERE id = ?").get(id));
}
export function parallelRunByRemote(remoteId) {
  return rowToParallelRun(db.prepare("SELECT * FROM parallel_runs WHERE remote_id = ?").get(remoteId));
}
export function parallelRunForResearch(researchId) {
  return rowToParallelRun(db.prepare("SELECT * FROM parallel_runs WHERE research_id = ? ORDER BY id DESC LIMIT 1").get(researchId));
}
export function parallelRunForTask(taskId) {
  return rowToParallelRun(db.prepare("SELECT * FROM parallel_runs WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(taskId));
}
export function setParallelRunStatus(id, { status, error = "", output = undefined }) {
  const now = clock.now();
  const done = ["completed", "failed", "cancelled"].includes(status);
  if (output !== undefined) {
    db.prepare("UPDATE parallel_runs SET status = ?, error = ?, output = ?, updated_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?")
      .run(status, error, JSON.stringify(output), now, done ? now : null, id);
  } else {
    db.prepare("UPDATE parallel_runs SET status = ?, error = ?, updated_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?")
      .run(status, error, now, done ? now : null, id);
  }
  return getParallelRun(id);
}
function rowToParallelRun(r) {
  if (!r) return null;
  let output = null;
  if (r.output) { try { output = JSON.parse(r.output); } catch { output = null; } }
  return { ...r, output };
}

// ---------- price watches (src/deals.js) ----------
//
// A price watch is a row in `watches` with kind 'price', so it is due, claimed, counted, listed and
// called off by exactly the code a page watch is (2026-10-23). What it adds is the offer trail: the
// verified offer it started from (offer_id, baseline_cents), the last verified one (last_offer_id,
// last_price_cents), and — once a drop is verified — the two offers that prove it (alert_offer_id
// against alert_prev_offer_id). consent_said is the person's own words agreeing to it. A watch that
// is stopped by code (the shop blocked, the page stopped carrying a price) gets stopped_at and the
// sentence why; blocked_at says the stop was a shop refusing to be read.
addColumnIfMissing("watches", "kind", "TEXT NOT NULL DEFAULT 'page'");
addColumnIfMissing("watches", "offer_id", "INTEGER");
addColumnIfMissing("watches", "baseline_cents", "INTEGER");
addColumnIfMissing("watches", "target_cents", "INTEGER");
addColumnIfMissing("watches", "currency", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("watches", "last_offer_id", "INTEGER");
addColumnIfMissing("watches", "last_price_cents", "INTEGER");
addColumnIfMissing("watches", "unverified_streak", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("watches", "alert_offer_id", "INTEGER");
addColumnIfMissing("watches", "alert_prev_offer_id", "INTEGER");
addColumnIfMissing("watches", "consent_said", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("watches", "stopped_at", "INTEGER");
addColumnIfMissing("watches", "stopped_why", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("watches", "blocked_at", "INTEGER");

export function createPriceWatch(conversationId, { offer, targetCents = null, everyMs, said, note = "", taskId = null }) {
  const r = db.prepare(`INSERT INTO watches
    (conversation_id, url, looking_for, note, every_ms, created_at, task_id, kind, offer_id, baseline_cents, target_cents,
     currency, last_offer_id, last_price_cents, consent_said, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'price', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, offer.url, targetCents != null ? `price at or below ${targetCents} cents` : "a lower verified price",
      note, everyMs, clock.now(), taskId, offer.id, offer.price_cents, targetCents, offer.currency || "",
      offer.id, offer.price_cents, String(said).slice(0, 500),
      // The offer it starts from was read just now, so the first recheck is a full interval away.
      clock.now());
  return getWatch(conversationId, Number(r.lastInsertRowid));
}
export function activePriceWatches(conversationId) {
  return db.prepare(`SELECT * FROM watches WHERE conversation_id = ? AND kind = 'price'
    AND met_at IS NULL AND cancelled_at IS NULL AND gave_up_at IS NULL`).all(conversationId);
}
/** A verified price that is not a drop: it becomes the price the next check is compared with. */
export function notePriceVerified(id, { offerId, priceCents }) {
  db.prepare("UPDATE watches SET last_offer_id = ?, last_price_cents = ?, unverified_streak = 0 WHERE id = ?").run(offerId, priceCents, id);
}
/** A check that verified nothing. Returns the run of them so far. */
export function notePriceUnverified(id) {
  db.prepare("UPDATE watches SET unverified_streak = unverified_streak + 1 WHERE id = ?").run(id);
  return db.prepare("SELECT unverified_streak FROM watches WHERE id = ?").get(id)?.unverified_streak ?? 0;
}
/** A verified drop: the watch is done, and the two offers that prove it are on the row. */
export function markPriceDrop(id, { offerId, priceCents, prevOfferId, why }) {
  db.prepare(`UPDATE watches SET met_at = ?, met_why = ?, alert_offer_id = ?, alert_prev_offer_id = ?,
    last_offer_id = ?, last_price_cents = ?, unverified_streak = 0 WHERE id = ? AND met_at IS NULL`)
    .run(clock.now(), String(why ?? ""), offerId, prevOfferId, offerId, priceCents, id);
}
/** Stopped by code, with the sentence why. `blocked` when it was the shop refusing to be read. */
export function stopPriceWatch(id, { why, blocked = false }) {
  const now = clock.now();
  db.prepare(`UPDATE watches SET gave_up_at = COALESCE(gave_up_at, ?), stopped_at = ?, stopped_why = ?, blocked_at = ?
    WHERE id = ? AND stopped_at IS NULL`).run(now, now, String(why ?? "").slice(0, 300), blocked ? now : null, id);
}
/** Price watches with something to tell: a verified drop, or a stop. Recent ones only. */
export function priceWatchNews(conversationId, { since }) {
  return db.prepare(`SELECT * FROM watches WHERE conversation_id = ? AND kind = 'price' AND cancelled_at IS NULL
    AND ((alert_offer_id IS NOT NULL AND met_at >= ?) OR (stopped_at IS NOT NULL AND stopped_at >= ?)) ORDER BY id`)
    .all(conversationId, since, since);
}

/** Watches whose next check is due: never checked, or last checked a full interval ago. */
export function dueWatches(now = clock.now()) {
  return db.prepare(`SELECT * FROM watches
    WHERE met_at IS NULL AND cancelled_at IS NULL AND gave_up_at IS NULL
      AND (last_checked_at IS NULL OR last_checked_at + every_ms <= ?)
    ORDER BY created_at`).all(now);
}
/**
 * Take this check before reading the page, or learn somebody else already has (2026-10-18).
 *
 * The check used to be written down AFTER the fetch and the model's verdict, a minute of awaits
 * later, so a second pass that listed due watches in that minute saw this one still due and read
 * and judged the page again — and on a met watch, both passes told them. The UPDATE is conditional
 * on the watch still being due, so exactly one caller gets `true`; the count and the clock move
 * here, and `noteWatchSeen` stores what the page said once it has been read.
 */
export function claimWatchCheck(id, now = clock.now()) {
  const r = db.prepare(`UPDATE watches SET checks = checks + 1, last_checked_at = ?
    WHERE id = ? AND met_at IS NULL AND cancelled_at IS NULL AND gave_up_at IS NULL
      AND (last_checked_at IS NULL OR last_checked_at + every_ms <= ?)`).run(now, id, now);
  return Number(r.changes) === 1;
}
export function noteWatchSeen(id, seen) {
  db.prepare("UPDATE watches SET last_seen = ? WHERE id = ?").run(seen, id);
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

export function createPage(conversationId, { title, blocks, subtitle = null, closing = null }) {
  const now = clock.now();
  const id = pageId();
  db.prepare(`INSERT INTO pages (id, conversation_id, title, content, shared, revision, created_at, updated_at, owner_key, subtitle, closing)
    VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?)`)
    .run(id, conversationId, seal2(conversationId, title), seal2(conversationId, JSON.stringify(blocks)), now, now, pageKey(),
      seal2(conversationId, subtitle || null), seal2(conversationId, closing || null));
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

/**
 * This conversation's page for a standing job, if it has one yet.
 *
 * The point is the link. A page of what is open is only worth anything if it is the SAME page every
 * time — one they can keep, where a tap tomorrow shows today's state. So the role is on the row and
 * the page is updated in place rather than remade, which is also why `page_delete` on it is an
 * ordinary delete: they threw it away, and the next one starts a new link honestly.
 */
export function pageWithRole(conversationId, role) {
  return rowToPage(db.prepare("SELECT * FROM pages WHERE conversation_id = ? AND role = ? ORDER BY created_at LIMIT 1").get(conversationId, role));
}

export function setPageRole(id, role) {
  db.prepare("UPDATE pages SET role = ? WHERE id = ?").run(role, id);
  return getPage(id);
}

export function listPages(conversationId) {
  return db.prepare("SELECT * FROM pages WHERE conversation_id = ? ORDER BY updated_at DESC").all(conversationId).map(rowToPage);
}

// ---------- one person's pages, linked to each other ----------
// A page is something they keep, so after a few of them there is a small body of work with no way
// through it: every page is a dead end you can only get back to by scrolling up a text thread to
// find the link again. These are the words a title is compared on.
//
// Two bars, both deliberate. The conversation is the hard one: related only ever means another page
// of THEIRS, so the query is scoped and there is no argument by which another person's page could
// reach the list. The second is relevance — a page links to the two or three it is really about and
// to nothing else, because "every page links to every page" is a footer, not a way through.

// Function words. Dropped before anything is compared, so "Gift ideas for Mum" and "Somewhere to
// eat in Accra" are not related because they both say "for" or "in".
const TITLE_STOPWORDS = new Set([
  "the", "and", "for", "with", "you", "your", "yours", "our", "their", "from", "that", "this",
  "what", "how", "when", "where", "why", "who", "are", "was", "were", "been", "being", "its",
  "not", "but", "all", "any", "can", "could", "should", "would", "about", "into", "over",
  "under", "than", "then", "there", "here", "have", "has", "had", "get", "got", "out", "off",
  "per", "via", "mine", "very", "just", "also", "some",
]);

// Words a page title reaches for whatever it is about. They count, but not on their own: two pages
// sharing only "ideas" are two pages that happen to be lists, not two pages about one thing.
const GENERIC_TITLE_WORDS = new Set([
  "guide", "idea", "plan", "list", "note", "option", "pick", "update", "page", "thing",
  "info", "summary", "overview", "tip", "step", "detail", "answer", "question", "week",
]);

const DISTINCT_WORD_SCORE = 2;
const GENERIC_WORD_SCORE = 1;
/** Two points: one real word in common, or two of the vague ones. One "ideas" is not a link. */
export const RELATED_MIN_SCORE = 2;
/** Three is a way through. A dozen is a sitemap, and nobody taps the ninth link on a phone. */
export const RELATED_MAX = 3;

/**
 * The words of a title worth comparing: lowercased, split on anything that is not a letter or a
 * digit, function words gone, and a trailing plural "s" taken off so "Coffee grinders" and
 * "Coffee grinder" are the same word. Exported for the tests, which pin the bar rather than the
 * list of words.
 */
export function titleWords(title) {
  const out = new Set();
  for (const raw of String(title ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const w = raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (w.length < 3 || TITLE_STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

function titleOverlap(mine, theirs) {
  let score = 0;
  for (const w of theirs) {
    if (mine.has(w)) score += GENERIC_TITLE_WORDS.has(w) ? GENERIC_WORD_SCORE : DISTINCT_WORD_SCORE;
  }
  return score;
}

/**
 * The other pages of this person's that this one is about — the few worth a tap at the bottom of it.
 *
 * Scoped by conversation and by id: the page has to be one of theirs for the list to be built at
 * all, and nothing outside their own conversation is ever a candidate. Ordered by how much of the
 * title is really shared, then by which was touched most recently, and cut at RELATED_MAX.
 *
 * Returns [] rather than something weaker when there is no real match, because a Related section
 * drawn out of the three most recent pages is a section that lies.
 */
export function relatedPages(conversationId, id, { limit = RELATED_MAX } = {}) {
  const page = getPageIn(conversationId, id);
  if (!page || limit < 1) return [];
  const mine = titleWords(page.title);
  if (!mine.size) return [];
  // Bounded: a conversation with hundreds of pages scores the recent ones rather than all of them.
  const rows = db.prepare(
    "SELECT * FROM pages WHERE conversation_id = ? AND id != ? ORDER BY updated_at DESC LIMIT 200",
  ).all(conversationId, id);
  return rows
    .map(r => ({ r, score: titleOverlap(mine, titleWords(r.title)) }))
    .filter(x => x.score >= RELATED_MIN_SCORE)
    .sort((a, b) => b.score - a.score || b.r.updated_at - a.r.updated_at)
    .slice(0, limit)
    .map(x => rowToPage(x.r));
}

/** Same id, same link, one more revision. That is the whole point of update. */
export function updatePage(conversationId, id, { title, blocks, subtitle, closing }) {
  const page = getPageIn(conversationId, id);
  if (!page) return null;
  // undefined keeps what is there; an empty string clears it.
  const sub = subtitle === undefined ? page.subtitle : (subtitle || null);
  const close = closing === undefined ? page.closing : (closing || null);
  db.prepare("UPDATE pages SET title = ?, content = ?, subtitle = ?, closing = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
    .run(seal2(page.conversation_id, title ?? page.title), seal2(page.conversation_id, JSON.stringify(blocks ?? page.blocks)),
      seal2(page.conversation_id, sub), seal2(page.conversation_id, close), clock.now(), id);
  return getPage(id);
}


/** Put a page away (E4). Its owner's link then says where it went; the row and its content stay. */
export function archivePage(conversationId, id) {
  const r = db.prepare("UPDATE pages SET state = 'archived', archived_at = ? WHERE id = ? AND conversation_id = ? AND state != 'archived'")
    .run(clock.now(), id, conversationId);
  return r.changes > 0;
}

/** Bring an archived page back to its link. */
export function restorePage(conversationId, id) {
  const r = db.prepare("UPDATE pages SET state = 'active', archived_at = NULL WHERE id = ? AND conversation_id = ? AND state = 'archived'")
    .run(id, conversationId);
  return r.changes > 0;
}

/** One purchase by its row id, scoped to the conversation it was made for (a receipt page, Pages v2 P6). */
export function agentcardPurchaseById(conversationId, id) {
  return db.prepare("SELECT * FROM agentcard_purchases WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
}

// ---------- documents: a file Reason really wrote ----------
/**
 * How long a document's id is. Shorter than a page's because it is not the whole of a secret: the
 * owner-only link to a document carries a key as well, exactly as a page's does.
 */
export const DOCUMENT_ID_LENGTH = 10;

/**
 * An id for a document that does not exist yet.
 *
 * Minted before the file is written rather than by the insert, because the id is in the filename
 * and the row is only written once the bytes are really on disk with their real size and checksum.
 * A row pointing at a file that was never written is the one state worth designing out: it is what
 * makes Reason able to say it has a document it cannot send.
 */
export function newDocumentId() {
  return linkToken(DOCUMENT_ID_LENGTH);
}

export function createDocument(conversationId, { id, kind, title, subtitle = null, closing = null, blocks, filename, path, bytes, sha256 }) {
  db.prepare(`INSERT INTO documents
    (id, conversation_id, kind, title, subtitle, closing, content, filename, path, bytes, sha256, owner_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, conversationId, kind, seal2(conversationId, title), seal2(conversationId, subtitle || null), seal2(conversationId, closing || null),
      seal2(conversationId, JSON.stringify(blocks)),
      filename, path, bytes, sha256, linkToken(PAGE_KEY_LENGTH), clock.now());
  return getDocument(id);
}

function rowToDocument(r) {
  if (!r) return null;
  return { ...r, blocks: JSON.parse(r.content) };
}

/** By id, from anywhere — the download route has an id and no conversation. */
export function getDocument(id) {
  return rowToDocument(db.prepare("SELECT * FROM documents WHERE id = ?").get(id));
}

/** By id, scoped — a tool may only touch a document in its own conversation. */
export function getDocumentIn(conversationId, id) {
  return rowToDocument(db.prepare("SELECT * FROM documents WHERE id = ? AND conversation_id = ?").get(id, conversationId));
}

export function listDocuments(conversationId) {
  return db.prepare("SELECT * FROM documents WHERE conversation_id = ? ORDER BY created_at DESC").all(conversationId).map(rowToDocument);
}

/** Written only when a send really came back ok. Reason's rule: send first, then claim. */
export function markDocumentSent(id, at = clock.now()) {
  db.prepare("UPDATE documents SET sent_at = ? WHERE id = ?").run(at, id);
  return getDocument(id);
}

/** The row goes here; the file on disk is the caller's to unlink (src/documents/store.js). */
export function deleteDocument(conversationId, id) {
  const doc = getDocumentIn(conversationId, id);
  if (!doc) return null;
  db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  return doc;
}

/**
 * Every document file this conversation has, or every one on the install. The same shape and the
 * same purpose as `recordingFiles`: an export carries these bytes and a delete unlinks them, and
 * both need the list read off the rows before the rows go.
 */
export function documentFiles(conversationId = null) {
  const sql = conversationId
    ? "SELECT id, conversation_id, kind, title, filename, path, bytes, sha256 FROM documents WHERE conversation_id = ? ORDER BY created_at ASC"
    : "SELECT id, conversation_id, kind, title, filename, path, bytes, sha256 FROM documents ORDER BY created_at ASC";
  return (conversationId ? db.prepare(sql).all(conversationId) : db.prepare(sql).all())
    .map(r => ({ document_id: r.id, conversation_id: r.conversation_id, kind: r.kind, title: r.title, file: r.path, filename: r.filename, bytes: r.bytes, sha256: r.sha256 }));
}

/** Gone, with everything hanging off it: the signed-in browsers, the codes, the picks. */
export function deletePage(conversationId, id) {
  const page = getPageIn(conversationId, id);
  if (!page) return null;
  for (const t of ["page_codes", "page_attempts", "page_choices"]) {
    db.prepare(`DELETE FROM ${t} WHERE page_id = ?`).run(id);
  }
  // A signed-in browser belongs to the person, so deleting one page does not sign them out of the rest.
  db.prepare("DELETE FROM page_sessions WHERE page_id = ? AND conversation_id IS NULL").run(id);
  db.prepare("DELETE FROM pages WHERE id = ?").run(id);
  return page;
}

// ---------- trips: the walks Reason made (src/trips.js) ----------
// The id is the link and the key is the owner's half of it, as for a page; the code gate and the
// signed-in browsers are the pages' own tables, keyed by the trip's id.
export const TRIP_ID_LENGTH = 12;

function rowToTrip(r) {
  if (!r) return null;
  return { id: r.id, conversation_id: r.conversation_id, owner_key: r.owner_key, trip: JSON.parse(r.trip), streets: r.streets ? JSON.parse(r.streets) : [], created_at: r.created_at, expires_at: r.expires_at };
}

export function createTrip(conversationId, trip, { expiresAt }) {
  const now = clock.now();
  // A walk is only worth keeping until it is walked: anything already out of date goes first.
  deleteExpiredTrips(now);
  const id = linkToken(TRIP_ID_LENGTH);
  db.prepare("INSERT INTO trips (id, conversation_id, owner_key, trip, streets, created_at, expires_at) VALUES (?, ?, ?, ?, NULL, ?, ?)")
    .run(id, conversationId, pageKey(), JSON.stringify({ ...trip, id }), now, expiresAt);
  return getTrip(id);
}

/** By id, while it lasts. An expired trip is gone on the read that finds it. */
export function getTrip(id, now = clock.now()) {
  const t = rowToTrip(db.prepare("SELECT * FROM trips WHERE id = ?").get(String(id ?? "")));
  if (t && t.expires_at <= now) { deleteTrip(t.id); return null; }
  return t;
}

export function updateTrip(id, trip, { streets } = {}) {
  db.prepare("UPDATE trips SET trip = ?, streets = COALESCE(?, streets) WHERE id = ?")
    .run(JSON.stringify({ ...trip, id }), streets ? JSON.stringify(streets) : null, id);
  return getTrip(id);
}

export function tripsFor(conversationId) {
  return db.prepare("SELECT * FROM trips WHERE conversation_id = ? AND expires_at > ? ORDER BY created_at DESC").all(conversationId, clock.now()).map(rowToTrip);
}

export function deleteTrip(id) {
  for (const t of ["page_codes", "page_attempts"]) db.prepare(`DELETE FROM ${t} WHERE page_id = ?`).run(id);
  db.prepare("DELETE FROM page_sessions WHERE page_id = ? AND conversation_id IS NULL").run(id);
  return db.prepare("DELETE FROM trips WHERE id = ?").run(id).changes === 1;
}

export function deleteExpiredTrips(now = clock.now()) {
  const gone = db.prepare("SELECT id FROM trips WHERE expires_at <= ?").all(now);
  for (const { id } of gone) deleteTrip(id);
  return gone.length;
}

// ---------- page access: codes, signed-in browsers, rate limit ----------
/**
 * How a one-time code is kept: its SHA-256, never the code (spec v3 §12). A code is short-lived and
 * rate limited, so the hash is not there to resist brute force — it is so a copy of the database, a
 * data export or a stray SELECT never holds a code anybody could type. Rows from before hashing
 * hold the bare code and expire within minutes; `pageCodeIs` reads both.
 */
export function pageCodeHash(code) {
  return `sha256:${createHash("sha256").update(String(code ?? "").trim().toUpperCase()).digest("hex")}`;
}
export function pageCodeIs(stored, typed) {
  const want = String(stored ?? "");
  const got = want.startsWith("sha256:") ? pageCodeHash(typed) : String(typed ?? "").trim().toUpperCase();
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * `bound` ties a sign-in code to the browser that asked for it (a hash, src/events.js
 * `signinBinding`; null for a page's own code gate). One live code per browser: asking again
 * kills that browser's old code, never the one somebody else's browser asked for — so a stranger
 * typing a person's number cannot kill the code the person is about to type (audit lead 25).
 */
export function createPageCode(pageId_, { code, ttlMs, bound = null }) {
  const now = clock.now();
  db.prepare("UPDATE page_codes SET expires_at = ? WHERE page_id = ? AND bound IS ? AND used_at IS NULL AND expires_at > ?")
    .run(now, pageId_, bound, now);
  const r = db.prepare("INSERT INTO page_codes (page_id, code, created_at, expires_at, bound) VALUES (?, ?, ?, ?, ?)")
    .run(pageId_, pageCodeHash(code), now, now + ttlMs, bound);
  return { id: Number(r.lastInsertRowid), code, expires_at: now + ttlMs };
}

/** End one code now, unused: a sign-in code that had its one try past the per-person ceiling. */
export function expirePageCode(id) {
  db.prepare("UPDATE page_codes SET expires_at = ? WHERE id = ? AND expires_at > ?").run(clock.now(), id, clock.now());
}

/** How many codes this page has had texted out in the window, so a held link cannot make a phone buzz all night. */
export function pageCodesIssued(pageId_, windowMs) {
  return db.prepare("SELECT COUNT(*) AS n FROM page_codes WHERE page_id = ? AND created_at >= ?")
    .get(pageId_, clock.now() - windowMs).n;
}

/** The newest live code for this page — or, with `bound`, the newest one that browser asked for. */
export function livePageCode(pageId_, { bound } = {}) {
  if (bound !== undefined) {
    return db.prepare("SELECT * FROM page_codes WHERE page_id = ? AND bound IS ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1")
      .get(pageId_, bound, clock.now()) ?? null;
  }
  return db.prepare("SELECT * FROM page_codes WHERE page_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1")
    .get(pageId_, clock.now()) ?? null;
}

export function usePageCode(id) {
  db.prepare("UPDATE page_codes SET used_at = ? WHERE id = ?").run(clock.now(), id);
}

/** Returns the row's id, for forgetPageAttempts. */
export function recordPageAttempt(pageId_, ok) {
  return Number(db.prepare("INSERT INTO page_attempts (page_id, at, ok) VALUES (?, ?, ?)").run(pageId_, clock.now(), ok ? 1 : 0).lastInsertRowid);
}

/** Take back attempts written down ahead of the answer (src/opspassword.js, when it was right). */
export function forgetPageAttempts(ids) {
  const del = db.prepare("DELETE FROM page_attempts WHERE rowid = ?");
  for (const id of ids) del.run(id);
}

/** How many wrong codes this page has had in the window. The rate limit reads this, not memory. */
export function failedPageAttempts(pageId_, windowMs) {
  return db.prepare("SELECT COUNT(*) AS n FROM page_attempts WHERE page_id = ? AND ok = 0 AND at >= ?")
    .get(pageId_, clock.now() - windowMs).n;
}

/** What a session is stored under: the sha256 of the browser's token, hex. Never the token itself. */
export function sessionKey(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}
function sk(token) { return sessionKey(token); }

export function startPageSession(pageId_, token, { conversationId = null } = {}) {
  const now = clock.now();
  const owner = conversationId ?? db.prepare("SELECT conversation_id FROM pages WHERE id = ?").get(pageId_)?.conversation_id ?? null;
  db.prepare("INSERT INTO page_sessions (token, page_id, conversation_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
    .run(sk(token), pageId_, owner, now, now);
  return token;
}

/**
 * Whose browser is this? The conversation a live session belongs to, or null. For a page that has
 * no row of its own (the status page), where the question is not "may this browser see page X" but
 * "is this browser the owner's at all". Ages out and touches last_seen the same way pageSessionValid does.
 */
export function pageSessionOwner(token, maxAgeMs, { idleMs = Infinity } = {}) {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM page_sessions WHERE token = ?").get(sk(token));
  if (!row?.conversation_id) return null;
  // Too old since it was made, or (Reason Web, owner decision 3) unused for too long: gone, and the
  // row with it, so the same cookie opens nothing anywhere afterwards.
  if (clock.now() - row.created_at > maxAgeMs || clock.now() - row.last_seen_at > idleMs) {
    db.prepare("DELETE FROM page_sessions WHERE token = ?").run(sk(token));
    return null;
  }
  db.prepare("UPDATE page_sessions SET last_seen_at = ? WHERE token = ?").run(clock.now(), sk(token));
  zonescope.enter(row.conversation_id);
  return row.conversation_id;
}

/**
 * The secret a signed-in browser's forms must carry back (Reason Web). One per session, minted the
 * first time it is asked for, never in a URL or a log; null for a token that opens nothing.
 */
export function pageSessionCsrf(token) {
  if (!token) return null;
  const row = db.prepare("SELECT token, csrf FROM page_sessions WHERE token = ?").get(sk(token));
  if (!row) return null;
  if (row.csrf) return row.csrf;
  db.prepare("UPDATE page_sessions SET csrf = ? WHERE token = ? AND csrf IS NULL").run(randomBytes(16).toString("base64url"), sk(token));
  return db.prepare("SELECT csrf FROM page_sessions WHERE token = ?").get(sk(token))?.csrf ?? null;
}

/**
 * Is this browser signed in to this page's owner? A session proved on any page of theirs counts;
 * a page with no row (a ghost id) has no owner and so matches nothing. Touches last_seen so an idle
 * session can be aged out.
 */
export function pageSessionValid(pageId_, token, maxAgeMs) {
  if (!token) return false;
  const row = db.prepare(`SELECT s.* FROM page_sessions s JOIN pages p ON p.id = ?
    WHERE s.token = ? AND (s.page_id = p.id OR s.conversation_id = p.conversation_id)`).get(pageId_, sk(token));
  if (!row) return false;
  if (clock.now() - row.created_at > maxAgeMs) {
    db.prepare("DELETE FROM page_sessions WHERE token = ?").run(sk(token));
    return false;
  }
  db.prepare("UPDATE page_sessions SET last_seen_at = ? WHERE token = ?").run(clock.now(), sk(token));
  return true;
}

/** Is there a session row for this token at all? A read only: no ageing, no touch. */
export function pageSessionExists(token) {
  return !!token && !!db.prepare("SELECT 1 FROM page_sessions WHERE token = ?").get(sk(token));
}

/** Which sign-in made this session (its page_id: a page id, `wsign:…`, `esign:…`, `connect:…`), or null. A read only. */
export function pageSessionSource(token) {
  return token ? db.prepare("SELECT page_id FROM page_sessions WHERE token = ?").get(sk(token))?.page_id ?? null : null;
}

/** Whose session row this is (its conversation), or null. A read only. */
export function pageSessionConversation(token) {
  return token ? db.prepare("SELECT conversation_id FROM page_sessions WHERE token = ?").get(sk(token))?.conversation_id ?? null : null;
}

/** Sign one browser out: its session row is gone, so its cookie opens nothing anywhere. */
export function endPageSession(token) {
  if (!token) return false;
  return db.prepare("DELETE FROM page_sessions WHERE token = ?").run(sk(token)).changes === 1;
}

/** Sign every browser of one person out (spec v3 §12: revocable). Returns how many there were. */
export function endPageSessionsFor(conversationId) {
  if (!conversationId) return 0;
  return Number(db.prepare("DELETE FROM page_sessions WHERE conversation_id = ?").run(conversationId).changes);
}

/**
 * Every browser one person is signed in on (Reason Web Settings): its stored key (`token`, the hash,
 * never the browser's token), when it was made, when it
 * was last used and the browser it was last used from. Newest use first. Rows past `maxAgeMs` since
 * made, or `idleMs` unused, are not listed: they open nothing. An app session has no idle limit, so it stays listed and revocable.
 */
export function pageSessionsFor(conversationId, { maxAgeMs = Infinity, idleMs = Infinity } = {}) {
  if (!conversationId) return [];
  const now = clock.now();
  return db.prepare("SELECT token, created_at, last_seen_at, user_agent, client FROM page_sessions WHERE conversation_id = ? ORDER BY last_seen_at DESC, created_at DESC")
    .all(conversationId).filter(r => now - r.created_at <= maxAgeMs && (r.client === "ios" || now - r.last_seen_at <= idleMs));
}

/** The stored key of a token, for telling "this device" in a list of stored keys. */
export const pageSessionKey = (token) => (token ? sk(token) : null);
/** Which client issued the session with this stored key, or null. */
export function pageSessionClientByKey(key) {
  return key ? db.prepare("SELECT client FROM page_sessions WHERE token = ?").get(String(key))?.client ?? null : null;
}
/** Mark which client a session was issued to. */
export function setPageSessionClient(token, client) {
  return !!token && db.prepare("UPDATE page_sessions SET client = ? WHERE token = ?").run(client, sk(token)).changes === 1;
}
/** Which client a session was issued to, or null. A read only: no ageing, no touch. */
export function pageSessionClient(token) {
  return token ? db.prepare("SELECT client FROM page_sessions WHERE token = ?").get(sk(token))?.client ?? null : null;
}

/** The browser a session was just used from. Written only when it changed, capped at 300 characters. */
export function notePageSessionAgent(token, userAgent) {
  const ua = String(userAgent ?? "").slice(0, 300);
  if (!token || !ua) return false;
  return db.prepare("UPDATE page_sessions SET user_agent = ? WHERE token = ? AND (user_agent IS NULL OR user_agent != ?)").run(ua, sk(token), ua).changes === 1;
}

/** Sign one of THIS person's browsers out. A token that is somebody else's is untouched. */
export function endPageSessionOf(conversationId, token) {
  if (!conversationId || !token) return false;
  return db.prepare("DELETE FROM page_sessions WHERE token = ? AND conversation_id = ?").run(sk(token), conversationId).changes === 1;
}

/** The same, by the stored key a pageSessionsFor row carries (Web Settings' list never sees a token). */
export function endPageSessionKeyOf(conversationId, key) {
  if (!conversationId || !key) return false;
  return db.prepare("DELETE FROM page_sessions WHERE token = ? AND conversation_id = ?").run(String(key), conversationId).changes === 1;
}

/**
 * How Reason reaches this person when it starts a message itself (Reason Web Settings, Gap 5):
 *   'text' everything (NULL and anything unknown read as this: how Reason always worked)
 *   'web'  timely decisions: a finished job's result stays on Web, everything timely is texted
 *   'yes'  only what needs a yes: approvals are texted, everything else stays on Web
 *   'none' nothing: everything Reason starts stays on Web
 * The two values stored before v2 keep their meaning, so nobody's delivery changed with it.
 */
export const WEB_REACH_VALUES = ["web", "text", "yes", "none"];
export function webReach(conversationId) {
  const v = db.prepare("SELECT web_reach FROM accounts WHERE conversation_id = ?").get(conversationId)?.web_reach;
  return WEB_REACH_VALUES.includes(v) ? v : "text";
}
export function setWebReach(conversationId, value) {
  if (!WEB_REACH_VALUES.includes(value)) throw new Error(`web_reach must be one of ${WEB_REACH_VALUES.join(", ")}, not ${value}`);
  return db.prepare("UPDATE accounts SET web_reach = ? WHERE conversation_id = ?").run(value, conversationId).changes === 1;
}

/**
 * Whose live Web session this is, WITHOUT counting it as used: for the small background check an
 * open tab makes every few seconds (src/pages/webnotify.js). Touching last_seen there would keep a
 * forgotten background tab signed in forever, past the idle sign-out (owner decision 3).
 */
export function pageSessionPeek(token, maxAgeMs, { idleMs = Infinity } = {}) {
  if (!token) return null;
  const row = db.prepare("SELECT conversation_id, created_at, last_seen_at FROM page_sessions WHERE token = ?").get(sk(token));
  if (!row?.conversation_id) return null;
  const now = clock.now();
  if (now - row.created_at > maxAgeMs || now - row.last_seen_at > idleMs) return null;
  zonescope.enter(row.conversation_id);
  return row.conversation_id;
}

/** Browser notifications on this one browser (Gap 8C): true only when it asked for them. */
export function pageSessionNotify(token) {
  return !!token && Number(db.prepare("SELECT web_notify FROM page_sessions WHERE token = ?").get(sk(token))?.web_notify ?? 0) === 1;
}
/** Turn them on or off for one of THIS person's browsers. A token that is somebody else's is untouched. */
export function setPageSessionNotify(conversationId, token, on) {
  if (!conversationId || !token) return false;
  return db.prepare("UPDATE page_sessions SET web_notify = ? WHERE token = ? AND conversation_id = ?").run(on ? 1 : 0, sk(token), conversationId).changes === 1;
}

/** The theme this person chose on Web (paper | night | auto), or null when they never chose one. */
export function webTheme(conversationId) {
  const t = db.prepare("SELECT web_theme FROM accounts WHERE conversation_id = ?").get(conversationId)?.web_theme;
  return ["paper", "night", "auto"].includes(t) ? t : null;
}
export function setWebTheme(conversationId, value) {
  if (!["paper", "night", "auto"].includes(value)) throw new Error(`web_theme must be paper, night or auto, not ${value}`);
  return db.prepare("UPDATE accounts SET web_theme = ? WHERE conversation_id = ?").run(value, conversationId).changes === 1;
}

/** The call voice trial this account chose ("cartesia"), or "" for today's voice. */
export function callTrial(conversationId) {
  const t = db.prepare("SELECT call_trial FROM accounts WHERE conversation_id = ?").get(conversationId)?.call_trial;
  return t === "cartesia" ? "cartesia" : "";
}
export function setCallTrial(conversationId, value) {
  if (!["", "cartesia"].includes(value)) throw new Error(`call_trial must be "" or cartesia, not ${value}`);
  return db.prepare("UPDATE accounts SET call_trial = ? WHERE conversation_id = ?").run(value, conversationId).changes === 1;
}

/** How many browsers one person is signed in on. */
export function pageSessionCount(conversationId, maxAgeMs) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM page_sessions WHERE conversation_id = ? AND created_at >= ?").get(conversationId, clock.now() - maxAgeMs).n);
}

/** Every account with this phone number, on any channel: who a number typed into a page belongs to. */
export function accountsByAddress(address) {
  return db.prepare(`SELECT * FROM accounts WHERE ${ACCOUNT_ADDR_MATCH} ORDER BY created_at`).all(...accountAddrArgs(address));
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
/**
 * `kind` and `from` say how these were seen and the page they sit on, when the caller knows: a
 * picture on a page carries that as its source line. A url seen twice keeps the first row's
 * provenance unless that row had none.
 */
export function rememberSeenUrls(conversationId, urls, { kind = "", from = "" } = {}) {
  const stmt = db.prepare("INSERT OR IGNORE INTO seen_urls (conversation_id, url, at, kind, from_url) VALUES (?, ?, ?, ?, ?)");
  const fill = db.prepare("UPDATE seen_urls SET kind = CASE WHEN kind = '' THEN ? ELSE kind END, from_url = CASE WHEN from_url = '' THEN ? ELSE from_url END WHERE conversation_id = ? AND url = ?");
  const now = clock.now();
  let n = 0;
  for (const u of urls ?? []) {
    if (typeof u === "string" && u.length < 2000) {
      stmt.run(conversationId, u, now, kind, from);
      if (kind || from) fill.run(kind, from, conversationId, u);
      n++;
    }
  }
  return n;
}

// The photo chosen for a place card, per place (src/choicecards.js placePhoto): the next set that
// shows the same place reuses it instead of reading and looking again.
db.exec("CREATE TABLE IF NOT EXISTS place_photos (key TEXT PRIMARY KEY, url TEXT NOT NULL, shows TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL)");
export function placePhotoFor(key, since) {
  return db.prepare("SELECT url, shows, at FROM place_photos WHERE key = ? AND at >= ?").get(key, since) ?? null;
}
// A place a lookup returned, by its phone number: the zone it is in, so a call to it is timed by its own
// clock after a restart too (src/zone.js `calleeZone`). Public facts about a business; nobody's rows.
db.exec("CREATE TABLE IF NOT EXISTS place_zones (phone TEXT PRIMARY KEY, zone TEXT NOT NULL, at INTEGER NOT NULL)");
export function placeZone(phone) {
  return db.prepare("SELECT zone FROM place_zones WHERE phone = ?").get(String(phone ?? ""))?.zone ?? "";
}
export function rememberPlaceZone(phone, zone, at = clock.now()) {
  db.prepare("INSERT INTO place_zones (phone, zone, at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET zone = excluded.zone, at = excluded.at").run(String(phone), String(zone), at);
}
export function rememberPlacePhoto(key, { url, shows = "", at = clock.now() }) {
  db.prepare("INSERT INTO place_photos (key, url, shows, at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET url = excluded.url, shows = excluded.shows, at = excluded.at").run(key, url, shows ?? "", at);
}

/** The image addresses a tool saw on one page (seen_urls.from_url), oldest first. */
export function seenUrlsFrom(conversationId, fromUrl, limit = 60) {
  if (!fromUrl) return [];
  return db.prepare("SELECT url FROM seen_urls WHERE conversation_id = ? AND from_url = ? ORDER BY at, rowid LIMIT ?").all(conversationId, fromUrl, limit).map(r => r.url);
}

/** How a url was seen, or null if it never was. */
export function seenUrlInfo(conversationId, url) {
  const r = db.prepare("SELECT url, kind, from_url FROM seen_urls WHERE conversation_id = ? AND url = ?").get(conversationId, url);
  return r ? { url: r.url, kind: r.kind || "", from: r.from_url || "" } : null;
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
    niche: r.niche || "", niche_searches: r.niche_searches ?? 0,
    enough_at: r.enough_at ?? null, enough_why: r.enough_why || "",
    big: !!r.big, continue_task_id: r.continue_task_id ?? null, continue_day: r.continue_day ?? null,
    created_at: r.created_at, updated_at: r.updated_at, finished_at: r.finished_at ?? null,
  };
}

export function createResearch(conversationId, { question, queries = [], taskId = null, niche = "", big = false }) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO research (conversation_id, question, task_id, queries, niche, big, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(conversationId, question, taskId, JSON.stringify(queries), String(niche ?? ""), big ? 1 : 0, now, now);
  return getResearch(conversationId, Number(r.lastInsertRowid));
}

/**
 * Give this run its one background follow-up. Written only if it has none yet — the WHERE is the
 * "never chained" guarantee, so two racing turns cannot both give it one. True when this call won.
 */
export function claimResearchContinuation(conversationId, id, { taskId, day }) {
  const r = db.prepare(`UPDATE research SET continue_task_id = ?, continue_day = ?, updated_at = ?
    WHERE id = ? AND conversation_id = ? AND continue_task_id IS NULL`).run(taskId, day, clock.now(), id, conversationId);
  return r.changes === 1;
}

/** The run whose one background follow-up this task is, or null — what makes the task one-shot (runtime.js). */
export function researchForFollowUp(taskId) {
  return rowToResearch(db.prepare("SELECT * FROM research WHERE continue_task_id = ? ORDER BY id DESC LIMIT 1").get(taskId));
}

/** How many background follow-ups this person has been given on this install day. */
export function researchContinuationsOn(conversationId, day) {
  return db.prepare("SELECT COUNT(*) n FROM research WHERE conversation_id = ? AND continue_day = ?").get(conversationId, day)?.n ?? 0;
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

/** Open runs nobody has touched since `before` — what the sweep looks at for abandoned ones. */
export function staleOpenResearch(before) {
  return db.prepare("SELECT * FROM research WHERE state = 'open' AND updated_at < ? ORDER BY id").all(before).map(rowToResearch);
}

/**
 * What another run in this conversation already got for this url since `since`: a read row first,
 * else the latest failed or forbidden one. Null when no sibling run has been to it.
 */
export function siblingResearchSource(conversationId, url, { since, exceptId }) {
  return db.prepare(`SELECT s.* FROM research_sources s JOIN research r ON r.id = s.research_id
    WHERE r.conversation_id = ? AND s.url = ? AND s.research_id != ? AND s.at >= ?
      AND s.state IN ('read', 'failed', 'forbidden')
    ORDER BY (s.state = 'read') DESC, s.at DESC LIMIT 1`).get(conversationId, url, exceptId, since) ?? null;
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
  emitCompletion("research", { conversationId, id });
  return getResearch(conversationId, id);
}

/**
 * The model has decided it has enough on this question, and that decision is now a row.
 *
 * A cap ending a run is code saying stop. This is the model saying it, and it has to be written
 * down for the same reason the caps are: otherwise "I have enough" lasts exactly as long as the
 * context it was thought in, and the next wake starts searching the same question again. `enough_at`
 * is what makes that judgement survive a restart, and what lets `research` refuse to dig further.
 *
 * Any queries still planned are dropped, because they are exactly what a later call would pick up
 * and run — leaving them would mean "this is enough" and "there is more to do" both being true on
 * one row. Written once: a second call finds `enough_at` already set and changes nothing.
 */
export function markResearchEnough(conversationId, id, { why = "" } = {}) {
  const now = clock.now();
  db.prepare(`UPDATE research SET state = 'done', queries = '[]', enough_at = ?, enough_why = ?, updated_at = ?, finished_at = ?
    WHERE id = ? AND conversation_id = ? AND enough_at IS NULL`)
    .run(now, String(why ?? "").slice(0, 300), now, now, id, conversationId);
  emitCompletion("research", { conversationId, id });
  return getResearch(conversationId, id);
}

/**
 * This run, if it has already been called enough — null when it has not, or when there is no such
 * run here, so a caller can read the return as the answer to the question it asked.
 *
 * "The same question" is this row and nothing else. The key is the research id: a number Reason was
 * handed when the run started, which comes back on every result and on every task wake. It is never
 * the wording, and two things follow from that, both of them the point. Carrying on a run that has
 * been settled is refused, because that run IS the question. And a question that merely reads like
 * one already answered has its own id, so it is never held up — prices move, new models ship, and
 * "is the mini worth it?" asked in December is not the one asked in August.
 */
export function researchAlreadyEnough(conversationId, id) {
  const run = getResearch(conversationId, id);
  return run?.enough_at ? run : null;
}

/**
 * One query that really ran. Counted on the row too, so a cap can be checked without a join.
 *
 * A niche query is counted against its own column rather than the planned allowance, because the
 * two budgets exist for different reasons — see `researchNicheSearches` in src/config.js.
 */
export function countResearchSearch(researchId, query, { niche = "" } = {}) {
  const kind = String(niche ?? "");
  db.prepare("INSERT INTO research_queries (research_id, query, niche, at) VALUES (?, ?, ?, ?)").run(researchId, query, kind, clock.now());
  const column = kind ? "niche_searches" : "searches";
  db.prepare(`UPDATE research SET ${column} = ${column} + 1, updated_at = ? WHERE id = ?`).run(clock.now(), researchId);
  return db.prepare(`SELECT ${column} n FROM research WHERE id = ?`).get(researchId)?.n ?? 0;
}

export function listResearchQueries(researchId) {
  return db.prepare("SELECT query, niche, at FROM research_queries WHERE research_id = ? ORDER BY id").all(researchId);
}

/**
 * Add a source. A url can appear once per state, so the same page turning up in three searches is
 * one snippet row, and being read later adds a `read` row next to it rather than overwriting the
 * snippet — which keeps "what did you actually fetch" answerable afterwards.
 */
export function addResearchSource(researchId, { url, site, title = "", said = "", date = "", via, state, why = "", niche = "" }) {
  // A page already read does not go back to being a snippet because a later search turned it up
  // again. Otherwise the model is handed the same source twice with two different texts, and the
  // weaker one is the one it is likelier to quote.
  if (state === "found" && db.prepare("SELECT 1 FROM research_sources WHERE research_id = ? AND url = ? AND state = 'read'").get(researchId, url)) {
    return false;
  }
  db.prepare(`INSERT OR IGNORE INTO research_sources
    (research_id, url, site, title, said, date, via, state, why, niche, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(researchId, url, site, title, said, date, via, state, why, String(niche ?? ""), clock.now());
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

// ---------- saved sign-ins, OAuth tokens, and what a day cost ----------
// Three things arrived together and all three are scoped by conversation, because all three are
// the kind of thing that must never leak sideways: whether somebody is signed in to a shop, the
// token that lets Reason act as them, and how much they have spent today.
//
// CREATE TABLE IF NOT EXISTS plus the ALTERs below, so an install that already has rows keeps them.
db.exec(`
  -- A Spotify or Google grant, per person PER ACCOUNT. The token values live here and NOWHERE else:
  -- an export replaces them with a marker rather than carrying them out of the machine.
  --
  -- account_label is in the unique key, which is what lets one person connect a personal Gmail and
  -- a work Gmail and keep both. It is not decoration: it is the address Google itself reported for
  -- the grant, it is how the person names which account to act on, and it is what every message id,
  -- thread id, label id and event id below is implicitly scoped by. A provider that is still
  -- one-account-per-person needs no special case — Spotify never sets a label, so its rows all key on
  -- the empty string and there is still exactly one of them.
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '',
    expires_at INTEGER,
    account_label TEXT NOT NULL DEFAULT '',
    connected_at INTEGER NOT NULL,
    refreshed_at INTEGER,
    -- Which of this person's accounts to act on when they did not say. See setDefaultOauthAccount.
    is_default INTEGER NOT NULL DEFAULT 0,
    UNIQUE(conversation_id, provider, account_label)
  );
  -- One in-flight authorization handshake. The state IS the credential that ties the provider's
  -- callback back to a conversation, so it is random, single-use and short-lived — a replayable
  -- state would let the same callback be used twice.
  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    redirect_uri TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS spotify_join_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );
  -- Money that was actually committed, one row per approved commit. This table IS the daily cap:
  -- counting rows means restarting the process cannot reset how much somebody has spent today.
  CREATE TABLE IF NOT EXISTS spend (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    day TEXT NOT NULL,
    cents INTEGER NOT NULL,
    what TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    confirmation_id INTEGER,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS spend_by_day ON spend (conversation_id, day);
`);
// A saved sign-in is a connected account whose credential is a browser profile rather than a key,
// so it goes in the table that already answers "what can Reason reach" — with the state and the
// evidence for it, because "signed in" has to be something that was checked and not assumed.
addColumnIfMissing("connected_accounts", "state", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("connected_accounts", "evidence", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("connected_accounts", "checked_at", "INTEGER");
// Which of a person's Google accounts this row is about. A dead grant is per account — their work
// one expiring must not make Reason say their personal one needs reconnecting — and that is the
// whole reason this column exists. Empty for every other provider, which is every row that was
// here before: a provider with one account per person has nothing to tell apart.
addColumnIfMissing("connected_accounts", "account_label", "TEXT NOT NULL DEFAULT ''");
// Which button a site's saved login uses — google, apple, facebook, microsoft — or '' for the site's
// own form (src/socialsignin.js, 2026-11-10). Written only by a probe that found the site signed in,
// sealed at rest (restcrypt SENSITIVE2), so a lapsed session can be signed in again by pressing the
// same button rather than by asking the person how they sign in.
addColumnIfMissing("connected_accounts", "provider", "TEXT NOT NULL DEFAULT ''");
const SIGNIN_PROVIDERS = new Set(["google", "apple", "facebook", "microsoft"]);

// Several Google accounts for one person, on an install that already has rows.
//
// `oauth_tokens` was created with UNIQUE(conversation_id, provider) — one grant per person per
// provider — and a second Gmail would have overwritten the first. The unique key has to become
// (conversation_id, provider, account_label), and SQLite cannot alter a table constraint in place:
// the only way is to build the table again and copy the rows over.
//
// Two properties this is written for, because getting either wrong costs somebody their live
// connection:
//
//   - **Safe to run twice.** The shape is read out of sqlite_master and a table that already has the
//     new key returns immediately. Nothing here depends on a version number somebody has to
//     remember to bump.
//   - **Nothing is lost.** The copy names its columns, so every value — including the refresh token
//     that is the connection — moves across untouched, and the ids stay the ids. It runs inside one
//     transaction, so a database that is interrupted mid-migration still has the old table rather
//     than half of a new one.
function migrateOauthTokensPerAccount() {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'oauth_tokens'").get()?.sql ?? "";
  if (!sql) return { migrated: false, why: "there is no oauth_tokens table yet" };
  // The new key, written exactly as the CREATE above writes it. Whitespace-insensitive so a
  // reformat of that statement cannot make this re-run against an already-migrated table.
  if (/UNIQUE\s*\(\s*conversation_id\s*,\s*provider\s*,\s*account_label\s*\)/i.test(sql)) {
    return { migrated: false, why: "already keyed per account" };
  }
  const before = Number(db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get()?.n ?? 0);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE oauth_tokens_per_account (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        expires_at INTEGER,
        account_label TEXT NOT NULL DEFAULT '',
        connected_at INTEGER NOT NULL,
        refreshed_at INTEGER,
        is_default INTEGER NOT NULL DEFAULT 0,
        UNIQUE(conversation_id, provider, account_label)
      );
      INSERT INTO oauth_tokens_per_account
        (id, conversation_id, provider, access_token, refresh_token, scope, expires_at, account_label, connected_at, refreshed_at, is_default)
        SELECT id, conversation_id, provider, access_token, refresh_token, scope, expires_at, account_label, connected_at, refreshed_at, is_default
        FROM oauth_tokens;
      DROP TABLE oauth_tokens;
      ALTER TABLE oauth_tokens_per_account RENAME TO oauth_tokens;
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const after = Number(db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get()?.n ?? 0);
  return { migrated: true, rows: after, kept_every_row: after === before };
}
// `is_default` first, so the copy above has the column to carry across on an older install too.
addColumnIfMissing("oauth_tokens", "is_default", "INTEGER NOT NULL DEFAULT 0");
// PKCE: the code_verifier has to travel with the state from authorize to the callback, because the
// callback sends it to the token endpoint. Only X needs this today — GitHub and Spotify do not use
// PKCE — but it is on the table rather than on the provider so a future provider gets it for free.
addColumnIfMissing("oauth_states", "code_verifier", "TEXT NOT NULL DEFAULT ''");
// The provider's own authorize address for this state. The link Reason texts is its own start page
// (src/connectgate.js), which only sends a browser here once it is proved to be the asker's.
addColumnIfMissing("oauth_states", "authorize_url", "TEXT NOT NULL DEFAULT ''");
export const oauthPerAccountMigration = migrateOauthTokensPerAccount();

// oauth_tokens.access_token / refresh_token are sealed at rest (src/secretbox.js, AES-256-GCM under
// REASON_TOKEN_KEY) since 2026-10-23 — the same treatment the AgentCard tokens got. That covers every
// provider stored here: Google (Gmail, Calendar, Drive), Spotify, Uber, X, GitHub, and the Apple ID
// app-specific password iCloud keeps in access_token. saveOauthTokens seals, the readers below open,
// and the stored form never leaves this file. Rows written before the change are sealed here, once,
// the first time a process with the key opens the database; with token rows present and no key this
// throws, so Reason does not start rather than hand out a token it cannot protect.
export const oauthSealMigration = (() => {
  const rows = db.prepare("SELECT id, access_token, refresh_token FROM oauth_tokens WHERE access_token != '' OR refresh_token != ''").all();
  if (rows.length && !secretbox.hasKey()) secretbox.requireKey();
  const plain = rows.filter(r => (r.access_token && !secretbox.isSealed(r.access_token)) || (r.refresh_token && !secretbox.isSealed(r.refresh_token)));
  if (!plain.length) return { sealed: 0 };
  const up = db.prepare("UPDATE oauth_tokens SET access_token = ?, refresh_token = ? WHERE id = ?");
  const keep = v => (secretbox.isSealed(v) ? v : secretbox.seal(v));
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of plain) up.run(keep(r.access_token), keep(r.refresh_token), r.id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { sealed: plain.length };
})();

/** A grant as callers want it: tokens opened. The stored form never leaves this file. */
function openOauthRow(row) {
  if (!row) return null;
  return { ...row, access_token: secretbox.open(row.access_token), refresh_token: secretbox.open(row.refresh_token) };
}

/** How many stored oauth_tokens rows are sealed vs plain text, per provider. Counts only; no values. */
export function oauthTokenAudit() {
  const rows = db.prepare("SELECT provider, access_token, refresh_token FROM oauth_tokens").all();
  const out = { rows: rows.length, sealed: 0, plain: 0, empty: 0, byProvider: {} };
  for (const r of rows) {
    const p = (out.byProvider[r.provider] ??= { rows: 0, sealed: 0, plain: 0 });
    p.rows++;
    const vals = [r.access_token, r.refresh_token].filter(Boolean);
    if (!vals.length) { out.empty++; continue; }
    if (vals.every(v => secretbox.isSealed(v))) { out.sealed++; p.sealed++; } else { out.plain++; p.plain++; }
  }
  return out;
}


// An account row written before any of this knew about addresses belongs to whichever address the
// grant it came from is under. Backfilling it is what lets a dead work account be named as the dead
// one on an install that connected before today, instead of a row nobody can tell apart. Only ever
// fills a blank, only where there is exactly one grant to read it off, so running it again changes
// nothing.
for (const row of db.prepare(`SELECT ca.id AS id, ca.conversation_id AS conv FROM connected_accounts ca
  WHERE ca.account_label = '' AND ca.name IN ('gmail', 'google_calendar')`).all()) {
  const labels = db.prepare("SELECT account_label FROM oauth_tokens WHERE conversation_id = ? AND provider = 'google' AND account_label != ''")
    .all(row.conv);
  if (labels.length !== 1) continue;
  db.prepare("UPDATE connected_accounts SET account_label = ? WHERE id = ?").run(labels[0].account_label, row.id);
}

/**
 * Write down what a sign-in probe found. Only a probe calls this — there is no path by which
 * wanting to be signed in makes the row say so.
 *
 * A probe that comes back `signed_out` (or any read other than `signed_in` / `unknown`) revokes the live row, so `liveAccount` (and
 * therefore every status anybody reads) stops saying connected the moment the site stops agreeing.
 * The row is kept with its state and evidence, so "why does it think I am signed out" is answerable.
 */
export function recordSiteSignin(conversationId, site, { state, evidence = "", scopes = ["signed_in"], provider = "" }) {
  const now = clock.now();
  const row = liveAccount(conversationId, site);
  // The provider is written only with a signed-in state — "save the login only after it successfully
  // signs in" — and only when it names a real provider; a check that found the site signed out, or
  // that could not read the page, never puts a provider on the row. A signed-in check that did not
  // say which button keeps whatever was known.
  const prov = SIGNIN_PROVIDERS.has(String(provider ?? "").trim().toLowerCase()) ? String(provider).trim().toLowerCase() : "";
  if (state === "signed_in") {
    if (row) {
      if (prov) db.prepare("UPDATE connected_accounts SET state = ?, evidence = ?, checked_at = ?, provider = ? WHERE id = ? AND conversation_id = ?")
        .run(state, evidence, now, seal2(conversationId, prov), row.id, conversationId);
      else db.prepare("UPDATE connected_accounts SET state = ?, evidence = ?, checked_at = ? WHERE id = ?")
        .run(state, evidence, now, row.id);
      return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(row.id);
    }
    const r = db.prepare(`INSERT INTO connected_accounts (conversation_id, name, scopes, connected_at, state, evidence, checked_at, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(conversationId, site, JSON.stringify(scopes), now, state, evidence, now, seal2(conversationId, prov));
    return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(Number(r.lastInsertRowid));
  }
  // `unknown` is a page that could not be read, not a site that said "signed out" — so it never
  // revokes a live sign-in. Revoking on it is what turned one cut-off page load into every status
  // reading "not signed in" until somebody signed in again for nothing (#279).
  if (row && state === "unknown") return row;
  if (row) {
    db.prepare("UPDATE connected_accounts SET state = ?, evidence = ?, checked_at = ?, revoked_at = ? WHERE id = ?")
      .run(state, evidence, now, now, row.id);
    return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(row.id);
  }
  // Never signed in, and the check agrees. A row still goes in, with `revoked_at` set — so
  // `liveAccount` returns nothing and no status anywhere can read as connected — because "we
  // asked, at this time, and the site said this" is a fact worth keeping whatever the answer.
  // Writing nothing here is what made `npm run signin -- --list` report "never checked" one second
  // after a check really ran, which reads as a tool that did not work.
  const made = db.prepare(`INSERT INTO connected_accounts (conversation_id, name, scopes, connected_at, state, evidence, checked_at, revoked_at)
    VALUES (?, ?, '[]', ?, ?, ?, ?, ?)`).run(conversationId, site, now, state, evidence, now, now);
  return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(Number(made.lastInsertRowid));
}

/** The last thing anything said about this account, live row or not. */
export function lastAccountCheck(conversationId, name, { account } = {}) {
  return db.prepare(`SELECT * FROM connected_accounts WHERE conversation_id = ? AND name = ?${labelClause(account)}
    ORDER BY checked_at DESC, connected_at DESC LIMIT 1`).get(conversationId, name, ...labelArgs(account)) ?? null;
}

/** The last thing a probe said about this site, live row or not. Same question, site wording. */
export const lastSigninCheck = lastAccountCheck;

/** Every site this person is signed in to right now (live rows whose state a probe set to signed_in). */
export function liveSigninsFor(conversationId) {
  return db.prepare("SELECT * FROM connected_accounts WHERE conversation_id = ? AND revoked_at IS NULL AND state = 'signed_in' ORDER BY name ASC")
    .all(conversationId);
}

/**
 * An OAuth grant the provider will not renew any more.
 *
 * Written when a refresh comes back `invalid_grant`, which for Google is a weekly event: their
 * consent screen is in Testing mode and they expire a refresh token after seven days. It is not the
 * same thing as never having connected, and the difference is what somebody gets told — "it has
 * expired, here's a fresh link" rather than "you have not set this up". So the live row is revoked,
 * which makes every status stop saying connected, and the reason is kept on it in plain words.
 */
export function markAccountNeedsReconnect(conversationId, name, why, { account = "" } = {}) {
  const now = clock.now();
  const row = liveAccount(conversationId, name, { account });
  if (row) {
    db.prepare("UPDATE connected_accounts SET state = ?, evidence = ?, checked_at = ?, revoked_at = ? WHERE id = ?")
      .run("needs_reconnect", why, now, now, row.id);
    return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(row.id);
  }
  // Nothing live to revoke — a second dead refresh, or a token row with no account row. The fact is
  // still worth keeping, so the next status reads "expired" and not "never connected".
  const made = db.prepare(`INSERT INTO connected_accounts (conversation_id, name, scopes, connected_at, state, evidence, checked_at, revoked_at, account_label)
    VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?)`).run(conversationId, name, now, "needs_reconnect", why, now, now, String(account ?? ""));
  return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(Number(made.lastInsertRowid));
}

/** The dead-grant row for this account, if the last word on it was that it needs reconnecting. */
export function accountNeedsReconnect(conversationId, name, { account } = {}) {
  const last = lastAccountCheck(conversationId, name, { account });
  return last?.state === "needs_reconnect" && last.revoked_at ? last : null;
}

/**
 * Every address of this person's whose grant is dead, for this capability.
 *
 * The plural is the point: with two Gmails connected, one of them dying is a sentence about that one
 * — "your work one needs reconnecting, the personal one's fine" — and a status that collapsed them
 * would either hide a dead account or claim a working one is broken.
 */
export function accountsNeedingReconnect(conversationId, name) {
  return db.prepare(`SELECT * FROM connected_accounts WHERE conversation_id = ? AND name = ?
    AND state = 'needs_reconnect' AND revoked_at IS NOT NULL ORDER BY checked_at DESC`).all(conversationId, name);
}

/** Forget that it ever needed reconnecting — it just did, or it was disconnected on purpose. */
export function clearAccountNeedsReconnect(conversationId, name, { account } = {}) {
  return Number(db.prepare(`DELETE FROM connected_accounts WHERE conversation_id = ? AND name = ? AND state = 'needs_reconnect'${labelClause(account)}`)
    .run(conversationId, name, ...labelArgs(account)).changes);
}

// ---------- oauth tokens ----------
/**
 * Store a grant. One row per (person, provider, account), so connecting a second Gmail adds a row
 * and reconnecting the same address updates the one already there.
 *
 * Which row is written is decided by the account label and nothing else, which is what makes
 * "connecting the same address twice is not two accounts" a property of the key rather than a check
 * somebody remembered. Labels are matched case-insensitively, because Google reports an address in
 * whatever case the person typed it and KOFI@gmail.com is the same mailbox as kofi@gmail.com.
 */
export function saveOauthTokens(conversationId, provider, { accessToken, refreshToken = "", scope = "", expiresAt = null, accountLabel = "" }) {
  const now = clock.now();
  const label = String(accountLabel ?? "");
  // Sealed before anything touches the table; seal("") is "", so the keep-the-old-refresh-token
  // rule below still sees an empty incoming value as empty.
  const sealedAccess = secretbox.seal(accessToken);
  const sealedRefresh = secretbox.seal(refreshToken);
  // The row this grant belongs to. An incoming blank label means "whatever row is already here" —
  // which is what a token refresh looks like, and what every Spotify write looks like, since
  // Spotify never learns an address and keeps all its rows under the empty label.
  const existing = label
    ? getOauthTokens(conversationId, provider, { account: label })
    : getOauthTokens(conversationId, provider);
  if (existing) {
    db.prepare(`UPDATE oauth_tokens SET
      access_token = ?,
      -- A refresh response does not always carry a new refresh token; both Google's and Spotify's
      -- docs say to keep using the old one when it does not. So an empty incoming value must not
      -- erase it.
      refresh_token = CASE WHEN ? = '' THEN refresh_token ELSE ? END,
      scope = ?, expires_at = ?,
      account_label = CASE WHEN ? = '' THEN account_label ELSE ? END,
      refreshed_at = ?
      WHERE id = ?`)
      .run(sealedAccess, sealedRefresh, sealedRefresh, scope, expiresAt, label, label, now, existing.id);
    return openOauthRow(db.prepare("SELECT * FROM oauth_tokens WHERE id = ?").get(existing.id));
  }
  db.prepare(`INSERT INTO oauth_tokens (conversation_id, provider, access_token, refresh_token, scope, expires_at, account_label, connected_at, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, provider, sealedAccess, sealedRefresh, scope, expiresAt, label, now, now);
  return getOauthTokens(conversationId, provider, { account: label });
}

/**
 * One grant. Scoped by conversation, which is the whole of the isolation: there is no unscoped read,
 * so no argument the model could pass reaches another person's account.
 *
 * With no `account` this answers the person's default, or their only one — which is what every
 * caller written before there could be more than one means by it, and why nothing else had to change.
 */
export function getOauthTokens(conversationId, provider, { account = "" } = {}) {
  if (account) {
    return openOauthRow(db.prepare("SELECT * FROM oauth_tokens WHERE conversation_id = ? AND provider = ? AND LOWER(account_label) = LOWER(?)")
      .get(conversationId, provider, String(account)));
  }
  const rows = listOauthTokens(conversationId, provider);
  if (rows.length <= 1) return rows[0] ?? null;
  return rows.find(r => r.is_default) ?? rows[0];
}

/** Every grant this person has with this provider, oldest first so "their first one" is stable. */
export function listOauthTokens(conversationId, provider) {
  return db.prepare("SELECT * FROM oauth_tokens WHERE conversation_id = ? AND provider = ? ORDER BY connected_at ASC, id ASC")
    .all(conversationId, provider).map(openOauthRow);
}

/**
 * Which account to act on when they did not say. Exactly one row carries it, so setting it clears
 * the others in the same transaction — two defaults would be a state where "which one did it send
 * from" has two answers.
 *
 * Returns false when that address is not one of theirs, which is the same refusal every other
 * account argument gets: a label is only ever accepted against this person's own rows.
 */
export function setDefaultOauthAccount(conversationId, provider, account) {
  const row = getOauthTokens(conversationId, provider, { account });
  if (!row) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE oauth_tokens SET is_default = 0 WHERE conversation_id = ? AND provider = ?").run(conversationId, provider);
    db.prepare("UPDATE oauth_tokens SET is_default = 1 WHERE id = ?").run(row.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return true;
}

/**
 * Delete one account's grant, or all of this person's for the provider.
 *
 * `account` is required to delete just one: a blank label would otherwise read as "all of them",
 * which is the wrong way round for a function whose job is removal.
 */
export function deleteOauthTokens(conversationId, provider, { account = null } = {}) {
  if (account) {
    return Number(db.prepare("DELETE FROM oauth_tokens WHERE conversation_id = ? AND provider = ? AND LOWER(account_label) = LOWER(?)")
      .run(conversationId, provider, String(account)).changes);
  }
  return Number(db.prepare("DELETE FROM oauth_tokens WHERE conversation_id = ? AND provider = ?").run(conversationId, provider).changes);
}

export function newOauthState({ conversationId, provider, scope = "", redirectUri = "", codeVerifier = "" }) {
  const state = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO oauth_states (state, conversation_id, provider, scope, redirect_uri, created_at, code_verifier) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(state, conversationId, provider, scope, redirectUri, clock.now(), codeVerifier);
  return state;
}

/**
 * Looked up once and spent. A state that comes back twice is not honoured the second time.
 *
 * `maxAgeMs` makes it expire too, which is a separate protection from being single-use: without one,
 * a link that was never opened stays good forever, and a connect link still sitting in somebody's
 * messages a week later should not be able to attach an account. Opt-in because the two providers
 * differ — Google's links expire (config.googleStateTtlMs) and Spotify's, written first, do not.
 */
export function spendOauthState(state, { maxAgeMs = null } = {}) {
  const row = db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(String(state ?? ""));
  if (!row || row.used_at) return null;
  // Spent either way: an expired state is not left lying around to be tried again.
  db.prepare("UPDATE oauth_states SET used_at = ? WHERE state = ?").run(clock.now(), row.state);
  if (maxAgeMs !== null && clock.now() - row.created_at > maxAgeMs) return null;
  return row;
}

/** Where a state's start page sends a proved browser (src/connectgate.js). */
export function setOauthStateAuthorizeUrl(state, url) {
  db.prepare("UPDATE oauth_states SET authorize_url = ? WHERE state = ?").run(String(url ?? ""), String(state ?? ""));
}

/** A state that has not been spent, without spending it: what the start page and the browser check read. */
export function peekOauthState(state) {
  const row = db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(String(state ?? ""));
  return row && !row.used_at ? row : null;
}

export function clearOauthStates(conversationId, provider) {
  return Number(db.prepare("DELETE FROM oauth_states WHERE conversation_id = ? AND provider = ?").run(conversationId, provider).changes);
}

// ---------- spotify join requests ----------

export function addSpotifyJoinRequest(conversationId, email) {
  return db.prepare(
    "INSERT INTO spotify_join_requests (conversation_id, email, created_at) VALUES (?, ?, ?)"
  ).run(conversationId, seal2(conversationId, email), clock.now());
}

export function pendingSpotifyJoins() {
  return db.prepare(
    "SELECT * FROM spotify_join_requests WHERE sent_at IS NULL ORDER BY id ASC"
  ).all();
}

export function markSpotifyJoinSent(id) {
  return db.prepare(
    "UPDATE spotify_join_requests SET sent_at = ? WHERE id = ?"
  ).run(clock.now(), id);
}

// ---------- spend ----------
export function spentToday(conversationId, day) {
  const row = db.prepare("SELECT COALESCE(SUM(cents), 0) AS cents, COUNT(CASE WHEN cents > 0 THEN 1 END) AS n FROM spend WHERE conversation_id = ? AND day = ?")
    .get(conversationId, day);
  return { cents: Number(row?.cents ?? 0), count: Number(row?.n ?? 0) };
}

export function recordSpend({ conversationId, day, cents, what = "", site = "", confirmationId = null }) {
  const r = db.prepare("INSERT INTO spend (conversation_id, day, cents, what, site, confirmation_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(conversationId, day, Math.round(cents), what, site, confirmationId, clock.now());
  return Number(r.lastInsertRowid);
}

/**
 * Take back the amount an unknown purchase outcome counted against the day, once AgentCard has
 * definitely answered that nothing was placed. Only the "(OUTCOME UNKNOWN)" row written for that
 * same confirm, shop and amount — one row, never a real spend.
 */
export function removeUnknownOutcomeSpend({ conversationId, confirmationId = null, site = "", cents = 0 }) {
  const row = db.prepare(`SELECT id FROM spend WHERE conversation_id = ? AND confirmation_id IS ? AND site = ? AND cents = ?
    AND what LIKE '% (OUTCOME UNKNOWN)' ORDER BY id DESC LIMIT 1`).get(conversationId, confirmationId, site, Math.round(Number(cents) || 0));
  if (!row) return 0;
  return Number(db.prepare("DELETE FROM spend WHERE id = ?").run(row.id).changes);
}

export function listSpend(conversationId, day) {
  return db.prepare("SELECT * FROM spend WHERE conversation_id = ? AND day = ? ORDER BY at DESC").all(conversationId, day);
}

// ---------- what each person has been told is new ----------
// Two states, and the gap between them is the honesty. A claim is the model saying its reply
// mentions the thing; told_at is the reply having actually gone out. See src/whatsnew.js and
// `_turn` in src/runtime.js, which commits or drops the claim.

/** What this person has really been told about. Only committed rows count. */
export function whatsNewHeard(conversationId) {
  return db.prepare("SELECT entry_id FROM whats_new_told WHERE conversation_id = ? AND told_at IS NOT NULL")
    .all(conversationId).map(r => r.entry_id);
}

/** When they were last told about anything, for the one-a-day limit. Null when never. */
export function lastWhatsNewTold(conversationId) {
  const row = db.prepare("SELECT MAX(told_at) AS at FROM whats_new_told WHERE conversation_id = ? AND told_at IS NOT NULL")
    .get(conversationId);
  return row?.at ?? null;
}

/**
 * The model says this reply mentions it. Returns the row id, or null when there is nothing to
 * claim because this entry is already down as told.
 *
 * Any earlier uncommitted claim in this conversation goes first: at most one entry rides on a
 * reply, and a claim left behind by a turn that sent nothing must never be committed by a later one.
 */
export function claimWhatsNew({ conversationId, entryId }) {
  db.prepare("DELETE FROM whats_new_told WHERE conversation_id = ? AND told_at IS NULL").run(conversationId);
  const r = db.prepare("INSERT OR IGNORE INTO whats_new_told (conversation_id, entry_id, claimed_at) VALUES (?, ?, ?)")
    .run(conversationId, entryId, clock.now());
  return Number(r.changes) ? Number(r.lastInsertRowid) : null;
}

/** The claim waiting on this conversation's next reply, if there is one. */
export function pendingWhatsNew(conversationId) {
  return db.prepare("SELECT * FROM whats_new_told WHERE conversation_id = ? AND told_at IS NULL ORDER BY claimed_at DESC LIMIT 1")
    .get(conversationId) ?? null;
}

/** The reply went. Returns the entry id written down, or null when there was no claim. */
export function markWhatsNewTold(conversationId) {
  const row = pendingWhatsNew(conversationId);
  if (!row) return null;
  db.prepare("UPDATE whats_new_told SET told_at = ? WHERE id = ?").run(clock.now(), row.id);
  return row.entry_id;
}

/** Nothing was sent, so nothing was heard. Returns the entry id that was dropped, or null. */
export function dropWhatsNewClaim(conversationId) {
  const row = pendingWhatsNew(conversationId);
  if (!row) return null;
  db.prepare("DELETE FROM whats_new_told WHERE id = ?").run(row.id);
  return row.entry_id;
}

// ---------- capability misses ----------
// When Reason tells somebody it cannot do something, the miss is recorded here. When the
// capability later goes live for that person, the turn note threads their original message.

export function recordCapabilityMiss({ conversationId, capability, summary, messageHandle = null }) {
  const r = db.prepare(
    "INSERT INTO capability_misses (conversation_id, capability, summary, message_handle, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(conversationId, capability, summary, messageHandle ?? null, clock.now());
  return Number(r.lastInsertRowid);
}

export function openMissesFor(conversationId) {
  return db.prepare(
    "SELECT * FROM capability_misses WHERE conversation_id = ? AND resolved_at IS NULL ORDER BY created_at"
  ).all(conversationId);
}

export function resolveMiss(id) {
  db.prepare("UPDATE capability_misses SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL").run(clock.now(), id);
}

// ---------- work the master handed to the assistant sessions on this machine ----------
//
// Its own schema block at the end of the file, like the sign-ins one above, so that adding to it
// never touches the big template at the top.
//
// The point of a table here rather than a variable is that a build outlives the turn that started
// it. Reason can be restarted, redeployed or killed while an assistant session is still working,
// and when it comes back it has to know what is in flight, which page belongs to it, and how much
// of it the master has already been told. All three of those live here.
db.exec(`
  CREATE TABLE IF NOT EXISTS remote_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    title TEXT NOT NULL,
    asked TEXT NOT NULL,
    brief TEXT NOT NULL,
    session_key TEXT NOT NULL,
    state TEXT NOT NULL,
    headline TEXT NOT NULL DEFAULT '',
    page_id TEXT,
    question TEXT,
    risky_action TEXT,
    turns INTEGER NOT NULL DEFAULT 0,
    drop_bytes INTEGER NOT NULL DEFAULT 0,
    run_dir TEXT NOT NULL DEFAULT '',
    -- The highest event id at the moment the turn now running started. What that turn did is read
    -- back as the events after this mark, which is what lets a question written in the first minute
    -- of an hour-long turn still be the thing the job is waiting on when the turn ends. Reading only
    -- the lines that arrived since the last sweep loses it, because an earlier sweep took them.
    turn_from INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER,
    last_sent_at INTEGER,
    sent_through INTEGER NOT NULL DEFAULT 0,
    notice_attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS remote_jobs_live ON remote_jobs (conversation_id, state);
  CREATE UNIQUE INDEX IF NOT EXISTS remote_jobs_key ON remote_jobs (session_key);
  CREATE TABLE IF NOT EXISTS remote_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    note TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    -- On a 'risky' event only: the exact thing the assistant would do, kept apart from the note so
    -- the words put in front of the master and the words the yes is checked against are one string.
    action TEXT NOT NULL DEFAULT '',
    -- On a 'question' event: the options it offered, as JSON, so the page can show them as taps.
    options TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS remote_events_job ON remote_events (job_id, id);
`);

// What Reason told the builder about HIM, kept in its own column rather than folded into the
// job's brief. Two reasons, and the second is the one that matters.
//
// It is his in a way the rest of the brief is not: the brief describes work, and this is his
// plans, his people and how he likes things. Its own column is what lets the page show him
// exactly what travelled, every time, without picking it back out of a paragraph — and "I found
// out by reading a file" is how this feature would lose his trust.
addColumnIfMissing("remote_jobs", "about_him", "TEXT NOT NULL DEFAULT ''");

/** The states a job can be in. Anything else is a bug, so the list is here and checked. */
export const REMOTE_STATES = ["working", "needs_you", "done", "failed", "stopped"];
/** The ones that are not over: what "in flight" means, in one place. */
export const REMOTE_LIVE_STATES = ["working", "needs_you"];

function rowToJob(r) {
  return r ? { ...r, finished: !REMOTE_LIVE_STATES.includes(r.state) } : null;
}

export function createRemoteJob(conversationId, { title, asked, brief, aboutHim = "", sessionKey, runDir }) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO remote_jobs
    (conversation_id, title, asked, brief, about_him, session_key, state, headline, run_dir, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'working', ?, ?, ?, ?)`)
    .run(conversationId, title, asked, brief, String(aboutHim ?? "").slice(0, 4000), sessionKey,
      "handed over just now", runDir, now, now);
  return getRemoteJobAnywhere(Number(r.lastInsertRowid));
}

/** By id, from anywhere — the sweep has a job and no conversation. */
export function getRemoteJobAnywhere(id) {
  return rowToJob(db.prepare("SELECT * FROM remote_jobs WHERE id = ?").get(id));
}

/** By id, scoped. A tool may only touch a job in its own conversation. */
export function getRemoteJob(conversationId, id) {
  return rowToJob(db.prepare("SELECT * FROM remote_jobs WHERE id = ? AND conversation_id = ?").get(id, conversationId));
}

export function remoteJobByKey(sessionKey) {
  return rowToJob(db.prepare("SELECT * FROM remote_jobs WHERE session_key = ?").get(sessionKey));
}

export function listRemoteJobs(conversationId, { includeFinished = true, limit = 40 } = {}) {
  const where = includeFinished
    ? "conversation_id = ?"
    : `conversation_id = ? AND state IN (${REMOTE_LIVE_STATES.map(() => "?").join(", ")})`;
  const args = includeFinished ? [conversationId] : [conversationId, ...REMOTE_LIVE_STATES];
  return db.prepare(`SELECT * FROM remote_jobs WHERE ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...args, limit).map(rowToJob);
}

/** Every unfinished job, whosever it is. What the sweep walks. */
export function liveRemoteJobs() {
  return db.prepare(`SELECT * FROM remote_jobs WHERE state IN (${REMOTE_LIVE_STATES.map(() => "?").join(", ")})
    ORDER BY id ASC`).all(...REMOTE_LIVE_STATES).map(rowToJob);
}

/** How many are still going, anywhere. The ceiling in src/remote.js is counted from this. */
export function liveRemoteJobCount(conversationId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM remote_jobs WHERE conversation_id = ?
    AND state IN (${REMOTE_LIVE_STATES.map(() => "?").join(", ")})`)
    .get(conversationId, ...REMOTE_LIVE_STATES).n;
}

/**
 * Change what is known about a job. Only the fields named are touched, so a sweep that learned one
 * thing cannot blank the rest — which is how a page id or a question gets quietly lost.
 */
export function updateRemoteJob(id, changes = {}) {
  const allowed = ["state", "headline", "page_id", "question", "risky_action", "turns", "drop_bytes", "turn_from", "finished_at", "last_sent_at", "sent_through", "notice_attempts", "brief", "about_him"];
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(changes)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    args.push(v);
  }
  if (!sets.length) return getRemoteJobAnywhere(id);
  sets.push("updated_at = ?");
  args.push(clock.now(), id);
  db.prepare(`UPDATE remote_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return getRemoteJobAnywhere(id);
}

export function logRemoteEvent(jobId, { kind, note, detail = "", action = "", options = [], at = clock.now() }) {
  const r = db.prepare("INSERT INTO remote_events (job_id, at, kind, note, detail, action, options) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(jobId, at, kind, String(note ?? "").slice(0, 4000), String(detail ?? "").slice(0, 8000),
      String(action ?? "").slice(0, 500), options?.length ? JSON.stringify(options) : "");
  return Number(r.lastInsertRowid);
}

function rowToEvent(r) {
  let options = [];
  if (r.options) { try { options = JSON.parse(r.options); } catch { options = []; } }
  return { ...r, options: Array.isArray(options) ? options : [] };
}

export function remoteEvents(jobId, { limit = 200 } = {}) {
  return db.prepare("SELECT * FROM remote_events WHERE job_id = ? ORDER BY id ASC LIMIT ?").all(jobId, limit).map(rowToEvent);
}

/** What one turn did: everything written down after the mark taken when that turn started. */
export function remoteEventsSince(jobId, afterId) {
  return db.prepare("SELECT * FROM remote_events WHERE job_id = ? AND id > ? ORDER BY id ASC").all(jobId, afterId).map(rowToEvent);
}

/** Everything written down about this job since the master was last told something. */
export function remoteNews(jobId, sentThrough) {
  return remoteEventsSince(jobId, sentThrough);
}

/** The highest event id on a job, so "is there news" is one read rather than a list. */
export function remoteLatestEventId(jobId) {
  return db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM remote_events WHERE job_id = ?").get(jobId).id;
}

/** Every job with something written down that has not been covered by a text yet. */
export function remoteJobsWithNews() {
  return db.prepare(`SELECT j.* FROM remote_jobs AS j
    WHERE EXISTS (SELECT 1 FROM remote_events AS e WHERE e.job_id = j.id AND e.id > j.sent_through)
    ORDER BY j.id ASC`).all().map(rowToJob);
}

/**
 * Claim this job's news before the turn that reports it runs, so two overlapping sweeps cannot both
 * take it. Returns the mark that was there before, for a caller that has to put it back because the
 * turn threw — losing a notice once is recoverable by asking; sending it four times is not.
 */
export function claimRemoteNews(id, throughEventId) {
  const was = db.prepare("SELECT sent_through FROM remote_jobs WHERE id = ?").get(id)?.sent_through ?? 0;
  const r = db.prepare("UPDATE remote_jobs SET sent_through = ?, last_sent_at = ?, updated_at = ? WHERE id = ? AND sent_through = ?")
    .run(throughEventId, clock.now(), clock.now(), id, was);
  return Number(r.changes) ? was : null;
}

/** Put a claim back, for a notice whose turn never got anywhere. */
export function releaseRemoteNews(id, was) {
  db.prepare("UPDATE remote_jobs SET sent_through = ? WHERE id = ?").run(was, id);
}

/**
 * The job whose question the master is being asked right now, if there is one. `withoutRisky`
 * skips the ones waiting on a yes for a risky action, which only remote_approve may answer.
 */
export function remoteJobAwaitingAnswer(conversationId, { withoutRisky = false } = {}) {
  return rowToJob(db.prepare(`SELECT * FROM remote_jobs WHERE conversation_id = ? AND state = 'needs_you'
    ${withoutRisky ? "AND (risky_action IS NULL OR risky_action = '')" : ""}
    ORDER BY updated_at DESC LIMIT 1`).get(conversationId));
}

/** Everything of one person's remote work, gone. Called from the delete-my-data path. */
export function deleteRemoteJobs(conversationId) {
  const ids = db.prepare("SELECT id FROM remote_jobs WHERE conversation_id = ?").all(conversationId).map(r => r.id);
  for (const id of ids) db.prepare("DELETE FROM remote_events WHERE job_id = ?").run(id);
  const r = db.prepare("DELETE FROM remote_jobs WHERE conversation_id = ?").run(conversationId);
  return Number(r.changes);
}

// ---------- standing permissions ----------
//
// A standing permission is one sentence the person said — "you can reorder groceries without
// asking" — kept word for word, next to the narrow reading of it that code can actually check.
//
// Two columns carry the whole idea and they are deliberately different kinds of thing:
//
//   `said`   their sentence, verbatim, exactly as it arrived. Never rewritten, never tidied. It is
//            what goes on the receipt and what gets read back to them, because a permission
//            summarised is a permission widened.
//   the rest the model's reading of that sentence in a fixed shape — which gated action, who or
//            what for, up to how much, until when. This is what the gate compares against, so
//            everything it allows is bounded by a value somebody can look at and disagree with.
//
// Its own schema block at the end of the file, like the sign-ins one, so adding to it never touches
// the big template at the top. Nothing here is ever swept on a timer: a permission is a record of
// having been given permission, which is the one thing a retention sweep must not quietly erase
// (see src/privacy.js). It goes when they revoke it, or when they delete their data.
db.exec(`
  CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    said TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    max_cents INTEGER,
    until_at INTEGER,
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS permissions_by_conversation ON permissions (conversation_id, revoked_at);
`);

export function grantPermission(conversationId, { said, action, target = "", maxCents = null, untilAt = null }) {
  const r = db.prepare(`INSERT INTO permissions
    (conversation_id, said, action, target, max_cents, until_at, granted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, said, action, target, maxCents, untilAt, clock.now());
  return getPermission(conversationId, Number(r.lastInsertRowid));
}

export function getPermission(conversationId, id) {
  return db.prepare("SELECT * FROM permissions WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
}

/** Live ones, newest first. `includeClosed` also returns the revoked, for "what did I take back". */
export function listPermissions(conversationId, { includeClosed = false } = {}) {
  const sql = includeClosed
    ? "SELECT * FROM permissions WHERE conversation_id = ? ORDER BY granted_at DESC"
    : "SELECT * FROM permissions WHERE conversation_id = ? AND revoked_at IS NULL ORDER BY granted_at DESC";
  return db.prepare(sql).all(conversationId);
}

export function revokePermission(conversationId, id) {
  const row = getPermission(conversationId, id);
  if (!row) return { ok: false, error: `There is no permission #${id} here.` };
  if (row.revoked_at) return { ok: false, error: `Permission #${id} was already taken back.`, permission: row };
  db.prepare("UPDATE permissions SET revoked_at = ? WHERE id = ?").run(clock.now(), id);
  return { ok: true, permission: getPermission(conversationId, id) };
}

// ---------- the limits a person sets, and a payment whose outcome nobody knows ----------
//
// Two tables, both added 2026-10-06, both about money and neither about the same thing as the
// operator's daily cap in src/config.js.
//
// `spend_caps` is the person's own two numbers: the most one thing may cost without them being
// asked, and the most in a calendar month. They are asked for once, the first time anything would
// spend money, and they are theirs to change. `said` keeps the sentence they set them with, for the
// same reason a standing permission keeps one: "raise my limit to $500" is the record, and $50000
// typed by mistake should be checkable against what they actually asked for.
//
// `unknown_outcomes` is the other half of never charging somebody twice. A commit that throws after
// the button has been pressed has an outcome nobody knows: the shop may have the order and may not.
// Retrying it is the one move that can take the money twice, so the row is written at the moment the
// outcome goes unknown and the same action is blocked until the person says to try again — and what
// counts as them saying so is a yes given AFTER the row, which no permission and no older yes can be.
db.exec(`
  CREATE TABLE IF NOT EXISTS spend_caps (
    conversation_id TEXT PRIMARY KEY,
    per_purchase_cents INTEGER NOT NULL,
    monthly_cents INTEGER NOT NULL,
    said TEXT NOT NULL DEFAULT '',
    set_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS unknown_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    why TEXT NOT NULL DEFAULT '',
    cents INTEGER,
    at INTEGER NOT NULL,
    cleared_at INTEGER,
    cleared_by_confirmation INTEGER
  );
  CREATE INDEX IF NOT EXISTS unknown_outcomes_open ON unknown_outcomes (conversation_id, action, cleared_at);
`);

export function getSpendCaps(conversationId) {
  return db.prepare("SELECT * FROM spend_caps WHERE conversation_id = ?").get(conversationId) ?? null;
}

export function setSpendCaps(conversationId, { perPurchaseCents, monthlyCents, said = "" }) {
  db.prepare(`INSERT INTO spend_caps (conversation_id, per_purchase_cents, monthly_cents, said, set_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      per_purchase_cents = excluded.per_purchase_cents,
      monthly_cents = excluded.monthly_cents,
      said = excluded.said,
      set_at = excluded.set_at`)
    .run(conversationId, Math.round(perPurchaseCents), Math.round(monthlyCents), said, clock.now());
  return getSpendCaps(conversationId);
}

/** What has been committed this calendar month. `month` is the first seven characters of a day. */
export function spentThisMonth(conversationId, month) {
  const row = db.prepare("SELECT COALESCE(SUM(cents), 0) AS cents, COUNT(CASE WHEN cents > 0 THEN 1 END) AS n FROM spend WHERE conversation_id = ? AND substr(day, 1, 7) = ?")
    .get(conversationId, month);
  return { cents: Number(row?.cents ?? 0), count: Number(row?.n ?? 0) };
}

export function listSpendMonth(conversationId, month) {
  return db.prepare("SELECT * FROM spend WHERE conversation_id = ? AND substr(day, 1, 7) = ? ORDER BY at DESC")
    .all(conversationId, month);
}

export function recordUnknownOutcome(conversationId, { action, target = "", why = "", cents = null }) {
  const r = db.prepare("INSERT INTO unknown_outcomes (conversation_id, action, target, why, cents, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(conversationId, action, target, why, cents, clock.now());
  return Number(r.lastInsertRowid);
}

/** The still-open unknown outcome for this exact action and target, if there is one. */
export function openUnknownOutcome(conversationId, action, target = "") {
  return db.prepare(`SELECT * FROM unknown_outcomes
    WHERE conversation_id = ? AND action = ? AND target = ? AND cleared_at IS NULL
    ORDER BY at DESC LIMIT 1`).get(conversationId, action, target) ?? null;
}

export function listUnknownOutcomes(conversationId, { includeCleared = false } = {}) {
  const sql = includeCleared
    ? "SELECT * FROM unknown_outcomes WHERE conversation_id = ? ORDER BY at DESC"
    : "SELECT * FROM unknown_outcomes WHERE conversation_id = ? AND cleared_at IS NULL ORDER BY at DESC";
  return db.prepare(sql).all(conversationId);
}

export function clearUnknownOutcome(id, { confirmationId = null } = {}) {
  db.prepare("UPDATE unknown_outcomes SET cleared_at = ?, cleared_by_confirmation = ? WHERE id = ? AND cleared_at IS NULL")
    .run(clock.now(), confirmationId, id);

}

// ---------- AgentCard: a card in somebody else's vault, and what was bought with it ----------
//
// Two tables and neither of them can hold a card. `agentcard_users` is one row per conversation: the
// vault session Reason minted, the `user_id` AgentCard gave back
// once the person finished, and the brand and last four of whatever they stored — display fields,
// which is all AgentCard will ever hand over. The card itself is encrypted on their own device
// before it leaves it, so there is nothing here to protect by not writing it down; what is here is
// the id that lets a purchase run as them.
//
// `agentcard_purchases` is one row per purchase CONVERSATION, keyed on AgentCard's own
// conversation id rather than on Reason's — a person can have several going at once, and the cart
// hash is only meaningful inside one of them. The row is what the confirm gate's target is built
// from (see confirmTargetFor in src/tools.js): the yes is pinned to the cart that was really shown,
// read back out of this table, never to what the model retyped. `status` tracks where it got to:
//   shopping            — in the /buy loop, nothing confirmable yet
//   cart_shown          — a cart with a hash and a total exists and the person can be asked
//   awaiting_approval   — the confirm paused for their passkey; NOTHING was charged
//   placed              — the order is at the shop
//   partially_placed    — some of it is
//   cancelled           — it was placed, and AgentCard's record of the order now says it is not
//                         coming (cancelled / canceled / failed / refunded). See reconcilePurchase.
//   declined / failed   — it is not, and why is on the row
//   outcome_unknown     — the confirm went out and nothing came back. See trust.retryBlocked.
db.exec(`
  CREATE TABLE IF NOT EXISTS agentcard_users (
    conversation_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT '',
    vault_session_id TEXT NOT NULL DEFAULT '',
    session_url TEXT NOT NULL DEFAULT '',
    session_expires_at TEXT NOT NULL DEFAULT '',
    linked_at INTEGER,
    card_brand TEXT NOT NULL DEFAULT '',
    card_last4 TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agentcard_users_by_user ON agentcard_users (user_id);
  CREATE INDEX IF NOT EXISTS agentcard_users_by_session ON agentcard_users (vault_session_id);
  CREATE TABLE IF NOT EXISTS agentcard_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    buy_conversation_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    cart_hash TEXT NOT NULL DEFAULT '',
    order_id TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL DEFAULT 0,
    merchant TEXT NOT NULL DEFAULT '',
    what TEXT NOT NULL DEFAULT '',
    decline_code TEXT NOT NULL DEFAULT '',
    charge_status TEXT NOT NULL DEFAULT '',
    authorization_id TEXT NOT NULL DEFAULT '',
    confirmation_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agentcard_purchases_by_conv ON agentcard_purchases (conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS agentcard_purchases_by_order ON agentcard_purchases (order_id);
  CREATE TABLE IF NOT EXISTS agentcard_events (
    event_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
`);
// Their own tokens, from the one exchange of their own vault link. Added after the tables shipped,
// so they go on by migration rather than in the CREATE above — an install that already has the
// tables (the live one does) would never see a changed CREATE TABLE IF NOT EXISTS.
//
// These ARE credentials and they are stored for the same reason a Google refresh token is: acting
// later, for the person who asked, is the whole point. `exchanged_session` is the session the pair
// came from, kept so a redelivered link event can tell "already done" from "never ran".
addColumnIfMissing("agentcard_users", "access_token", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_users", "refresh_token", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_users", "token_expires_at", "INTEGER");
addColumnIfMissing("agentcard_users", "exchanged_session", "TEXT NOT NULL DEFAULT ''");
// How the connection is keeping (2026-10-24). `refreshed_at` is the last rotation that went through;
// `refresh_failed_at` / `refresh_error` the last one that did not, for any reason; `connection_dead_at`
// is set only when AgentCard REFUSED the refresh token itself, which no retry can undo — the
// person has to open a new vault link. A network failure never sets it. A new exchange clears all
// three. No token value is ever written to any of them.
addColumnIfMissing("agentcard_users", "refreshed_at", "INTEGER");
addColumnIfMissing("agentcard_users", "refresh_failed_at", "INTEGER");
addColumnIfMissing("agentcard_users", "refresh_error", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_users", "connection_dead_at", "INTEGER");

// The two tokens are sealed at rest (src/secretbox.js, AES-256-GCM under REASON_TOKEN_KEY) since
// 2026-10-23; before that they were plain text. Every write seals and every read in this file opens,
// so nothing outside db.js ever sees the stored form. Rows written before the change are sealed here,
// once, the first time a process with the key opens the database. With token rows present and no key
// this throws — Reason does not start rather than store or hand out a token it cannot protect.
{
  const rows = db.prepare("SELECT conversation_id, access_token, refresh_token FROM agentcard_users WHERE access_token != '' OR refresh_token != ''").all();
  if (rows.length && !secretbox.hasKey()) secretbox.requireKey();
  const plain = rows.filter(r => (r.access_token && !secretbox.isSealed(r.access_token)) || (r.refresh_token && !secretbox.isSealed(r.refresh_token)));
  if (plain.length) {
    const up = db.prepare("UPDATE agentcard_users SET access_token = ?, refresh_token = ? WHERE conversation_id = ?");
    db.exec("BEGIN");
    try {
      for (const r of plain) {
        up.run(secretbox.isSealed(r.access_token) ? r.access_token : secretbox.seal(r.access_token),
          secretbox.isSealed(r.refresh_token) ? r.refresh_token : secretbox.seal(r.refresh_token), r.conversation_id);
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
}

// What the webhooks last said, kept apart from `status` (2026-10-23). `status` is written from the
// confirm call's own answer; a checkout_authorization.* event is never proof an order exists, so it
// only ever lands in authorization_state, and an order.* event in order_state.
addColumnIfMissing("agentcard_purchases", "authorization_state", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_purchases", "order_state", "TEXT NOT NULL DEFAULT ''");
db.exec("CREATE INDEX IF NOT EXISTS agentcard_purchases_by_auth ON agentcard_purchases (authorization_id)");

// What a money ask has to show and what a picked offer is checked against (2026-10-23).
//   address_json      the delivery address sent with the cart, so the confirm sends the SAME one and
//                     the ask can show it. purchase_confirm's input never carried an address, so
//                     until this the confirm always went out without one.
//   offer_id          the verified offer the person picked, when they picked one
//   offer_match       'match' | 'mismatch' | '' — the cart line's product_id against that offer;
//                     a 'mismatch' cart cannot be confirmed
//   cart_json         AgentCard's cart as read, so the ask is composed from it and not retyped
addColumnIfMissing("agentcard_purchases", "address_json", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_purchases", "offer_id", "INTEGER");
addColumnIfMissing("agentcard_purchases", "offer_match", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_purchases", "cart_json", "TEXT NOT NULL DEFAULT ''");

// What the shop said once it took the order, and whether a cancellation has been told (2026-10-24).
//   retailer_order_id   the shop's own order number, from AgentCard's orders[] or order.confirmed
//   delivery_window     the window the shop quoted, the same way
//   cancel_told_at      when the person was told the order was cancelled. Claimed once, by whichever
//                       path sees the cancellation first, so two events and a tool read cannot all
//                       say it (claimAgentcardCancelNotice).
addColumnIfMissing("agentcard_purchases", "retailer_order_id", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_purchases", "delivery_window", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_purchases", "cancel_told_at", "INTEGER");

// Why an order was cancelled, as the order.* webhook said it (2026-10-24).
//   cancel_reason   AgentCard's `canceled_reason` code, e.g. invalid_shipping_address
//   cancel_detail   the store's own line, `status_detail`, e.g. "The store could not use this shipping address."
// Written only while empty (noteAgentcardCancelReason): AgentCard re-posted the cancellation of order
// e66d7f2b… 48 ms after the first copy, under the same event id, with both fields null — the first copy
// is the one that counts, and a null never erases a reason already kept.
addColumnIfMissing("agentcard_purchases", "cancel_reason", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_purchases", "cancel_detail", "TEXT NOT NULL DEFAULT ''");

// A flight is a purchase like any other — the same row, the same cart hash, the same purchase_confirm
// — plus what a flight's yes has to be pinned to and what a flight's outcome has to be read from
// (src/flightbook.js, 2026-10-25). Empty on every row that is not a flight.
//   kind                 'flight', or '' for everything else
//   flight_json          the itinerary they picked (legs), the Fli search and option it came from,
//                        and the fresh Fli price, as JSON
//   traveler_ids         the flight_travelers ids flying, in order, as JSON
//   traveler_fp          src/flightbook.js travelerFingerprint of exactly those details — in the confirm
//                        target, because AgentCard's cart hash does not change when the passenger does
//   quote_checked_at     when the fresh quote (Fli re-check + AgentCard cart) was taken
//   approval_expires_at  when AgentCard's approval link stops working (ms), from the paused confirm
//   ticketing_state      src/flightbook.js BOOKING_STATES, as last read
//   order_raw_json       the first full order record / order.* body seen for this order, kept whole so
//                        the first live booking shows what a flight order really carries
addColumnIfMissing("agentcard_purchases", "kind", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_purchases", "flight_json", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_purchases", "traveler_ids", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_purchases", "traveler_fp", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_purchases", "quote_checked_at", "INTEGER");
addColumnIfMissing("agentcard_purchases", "approval_expires_at", "INTEGER");
addColumnIfMissing("agentcard_purchases", "ticketing_state", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_purchases", "order_raw_json", "TEXT NOT NULL DEFAULT ''");
// A placement that failed AFTER the person approved (2026-10-26: Target, `order.failed code=place`
// with order_id null, 2 s after each Face ID approval). The approval is consumed by the attempt, so
// the same confirm then needs a fresh one — which is the store's doing, not the person's. Kept so the
// next confirm can say so, and so the second failure on one cart stops the loop.
//   placement_failures    how many times the store refused to place this cart after an approval
//   placement_failed_at   when the last one landed (ms)
//   placement_fail_code   AgentCard's `code` on that order.failed (`place`, `prepare`, or a named one)
//   placement_fail_reason AgentCard's `message` on it, when it gave one
addColumnIfMissing("agentcard_purchases", "placement_failures", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("agentcard_purchases", "placement_failed_at", "INTEGER");
addColumnIfMissing("agentcard_purchases", "placement_fail_code", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_purchases", "placement_fail_reason", "TEXT NOT NULL DEFAULT ''");

// ---------- flight travelers ----------
//
// The people a flight is booked for, kept per conversation so a repeat trip is faster — and read back
// and agreed to again before every booking, never silently reused (the visible-memory rule). One row
// per traveler; `conversation_id` scopes it exactly like every memory table, and nothing reads a
// traveler without it.
//
// Everything that identifies the person — legal name, date of birth, gender, email, phone, known
// traveler and redress numbers — is in `details`, sealed (src/secretbox.js, AES-256-GCM under
// REASON_TOKEN_KEY) like a login token: a copy of reason.db is not a copy of anybody's passport page.
// `label` is the one thing kept plain, a first name and an initial, so a list can say who without
// opening anything.
//   confirmed_at   when they last said, in their own words, that these details are right
db.exec(`
  CREATE TABLE IF NOT EXISTS flight_travelers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    confirmed_at INTEGER,
    confirmed_said TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS flight_travelers_by_conv ON flight_travelers (conversation_id, updated_at);
`);

const TRAVELER_FIELDS = ["given_name", "family_name", "born_on", "gender", "email", "phone", "known_traveler_number", "redress_number"];

function openTraveler(row) {
  if (!row) return null;
  let d = {};
  try { d = JSON.parse(secretbox.open(row.details) || "{}"); } catch { d = {}; }
  const t = Object.fromEntries(TRAVELER_FIELDS.map(k => [k, d[k] ?? ""]));
  return { id: row.id, conversation_id: row.conversation_id, label: row.label, ...t, confirmed_at: row.confirmed_at ?? null, confirmed_said: row.confirmed_said, created_at: row.created_at, updated_at: row.updated_at };
}

/**
 * Keep one traveler, new or corrected. With no `said` (their own words) it is kept UNCONFIRMED — a
 * new or changed traveler is always a new read-back. An `id`
 * that is not this conversation's is refused (null) rather than written — a traveler belongs to the
 * Reason it was given to and to nobody else.
 */
export function saveFlightTraveler(conversationId, t, { id = null, said = "" } = {}) {
  const d = Object.fromEntries(TRAVELER_FIELDS.map(k => [k, String(t[k] ?? "").trim()]));
  const label = `${d.given_name} ${d.family_name.slice(0, 1)}${d.family_name ? "." : ""}`.trim();
  const sealed = secretbox.seal(JSON.stringify(d));
  const now = clock.now();
  if (id != null) {
    const r = db.prepare("UPDATE flight_travelers SET label = ?, details = ?, confirmed_at = ?, confirmed_said = ?, updated_at = ? WHERE id = ? AND conversation_id = ?")
      .run(label, sealed, said ? now : null, String(said).slice(0, 300), now, id, conversationId);
    return r.changes ? getFlightTraveler(conversationId, id) : null;
  }
  const r = db.prepare("INSERT INTO flight_travelers (conversation_id, label, details, confirmed_at, confirmed_said, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(conversationId, label, sealed, said ? now : null, String(said).slice(0, 300), now, now);
  return getFlightTraveler(conversationId, Number(r.lastInsertRowid));
}

export function getFlightTraveler(conversationId, id) {
  return openTraveler(db.prepare("SELECT * FROM flight_travelers WHERE conversation_id = ? AND id = ?").get(conversationId, id));
}

export function listFlightTravelers(conversationId) {
  return db.prepare("SELECT * FROM flight_travelers WHERE conversation_id = ? ORDER BY updated_at DESC, id DESC").all(conversationId).map(openTraveler);
}

/** They said these details still apply: stamp it, for this conversation's rows only. */
export function reconfirmFlightTravelers(conversationId, ids, said) {
  const now = clock.now();
  const stmt = db.prepare("UPDATE flight_travelers SET confirmed_at = ?, confirmed_said = ?, updated_at = ? WHERE id = ? AND conversation_id = ?");
  return ids.map(id => stmt.run(now, String(said).slice(0, 300), now, id, conversationId).changes === 1);
}

export function forgetFlightTraveler(conversationId, id) {
  return db.prepare("DELETE FROM flight_travelers WHERE id = ? AND conversation_id = ?").run(id, conversationId).changes === 1;
}

// Watching their own mail for the e-ticket (src/ticketcheck.js). One row per flight order, keyed by
// the AgentCard conversation and scoped by conversation_id like every table here. It keeps what the
// email PROVED and where it was read — ticket numbers, record locator, carrier, Gmail message id —
// and never a body, a subject or a sender.
//   state     watching | owed_airline (the "check with the airline" line is waiting to go)
//             | issued | gave_up | no_gmail | stopped
//   since     the order's creation: the search reads mail from then on, never before
//   next_at   when the next narrow search runs
db.exec(`
  CREATE TABLE IF NOT EXISTS flight_ticket_watch (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    buy_conversation_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'watching',
    since INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    next_at INTEGER NOT NULL,
    checks INTEGER NOT NULL DEFAULT 0,
    ticket_numbers TEXT NOT NULL DEFAULT '[]',
    pnr TEXT NOT NULL DEFAULT '',
    carrier TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '',
    told_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS flight_ticket_watch_due ON flight_ticket_watch (state, next_at);
`);
// Gmail ids of e-tickets seen BEFORE AgentCard placed the order: theirs (bought off the Google Flights
// link, say), never Reason's — so never counted, even once the order is placed.
addColumnIfMissing("flight_ticket_watch", "not_ours", "TEXT NOT NULL DEFAULT '[]'");

/** Keep a Gmail id as an e-ticket that is not this order's. */
export function ticketNotOurs(id, messageId, now = clock.now()) {
  const r = db.prepare("SELECT not_ours FROM flight_ticket_watch WHERE id = ?").get(id);
  let ids = [];
  try { ids = JSON.parse(r?.not_ours || "[]"); } catch { ids = []; }
  if (!ids.includes(messageId)) ids.push(String(messageId));
  db.prepare("UPDATE flight_ticket_watch SET not_ours = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(ids.slice(-50)), now, id);
}

const openWatch = (r) => {
  if (!r) return null;
  let tickets = [], notOurs = [];
  try { tickets = JSON.parse(r.ticket_numbers || "[]"); } catch { tickets = []; }
  try { notOurs = JSON.parse(r.not_ours || "[]"); } catch { notOurs = []; }
  return { ...r, tickets, notOurs };
};

/** Flight orders with no watch yet, in a status a ticket could still be coming for. */
export function flightOrdersToWatch() {
  return db.prepare(`SELECT p.* FROM agentcard_purchases p
    LEFT JOIN flight_ticket_watch w ON w.buy_conversation_id = p.buy_conversation_id
    WHERE p.kind = 'flight' AND w.id IS NULL AND p.status IN ('awaiting_approval', 'placed', 'partially_placed')`).all();
}

export function openTicketWatch({ conversationId, buyConversationId, since, nextAt, now = clock.now() }) {
  db.prepare(`INSERT OR IGNORE INTO flight_ticket_watch (conversation_id, buy_conversation_id, since, started_at, next_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(conversationId, buyConversationId, since, now, nextAt, now);
}

export function dueTicketWatches(now = clock.now()) {
  return db.prepare("SELECT * FROM flight_ticket_watch WHERE (state IN ('watching', 'owed_airline') OR (state = 'issued' AND told_at IS NULL)) AND next_at <= ? ORDER BY next_at").all(now).map(openWatch);
}

export function getTicketWatch(id) {
  return openWatch(db.prepare("SELECT * FROM flight_ticket_watch WHERE id = ?").get(id));
}

export function ticketWatchFor(conversationId, buyConversationId) {
  return openWatch(db.prepare("SELECT * FROM flight_ticket_watch WHERE conversation_id = ? AND buy_conversation_id = ?").get(conversationId, buyConversationId));
}

export function rescheduleTicketWatch(id, nextAt, now = clock.now()) {
  db.prepare("UPDATE flight_ticket_watch SET next_at = ?, checks = checks + 1, updated_at = ? WHERE id = ?").run(nextAt, now, id);
}

export function closeTicketWatch(id, state, now = clock.now()) {
  db.prepare("UPDATE flight_ticket_watch SET state = ?, updated_at = ? WHERE id = ?").run(state, now, id);
}

export function owedAirline(id, now = clock.now()) {
  db.prepare("UPDATE flight_ticket_watch SET state = 'owed_airline', checks = checks + 1, updated_at = ? WHERE id = ? AND state = 'watching'").run(now, id);
}

/** A record locator (or carrier) seen before any ticket: kept, and the watch goes on. */
export function noteTicketWatch(id, { pnr = "", carrier = "", messageId = "" }, now = clock.now()) {
  db.prepare("UPDATE flight_ticket_watch SET pnr = ?, carrier = CASE WHEN ? != '' THEN ? ELSE carrier END, message_id = ?, updated_at = ? WHERE id = ?")
    .run(pnr, carrier, carrier, messageId, now, id);
}

export function ticketIssued(id, { tickets, pnr = "", carrier = "", messageId = "" }, now = clock.now()) {
  db.prepare("UPDATE flight_ticket_watch SET state = 'issued', ticket_numbers = ?, pnr = ?, carrier = ?, message_id = ?, checks = checks + 1, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(tickets), pnr, carrier, messageId, now, id);
}

export function ticketToldAt(id, now = clock.now()) {
  db.prepare("UPDATE flight_ticket_watch SET told_at = ?, updated_at = ? WHERE id = ? AND told_at IS NULL").run(now, now, id);
}

// The first copy of each order.* event, as it arrived: what it said about the order. INSERT OR IGNORE
// keeps the first, so a later copy of the same id that drops fields cannot overwrite it.
addColumnIfMissing("agentcard_events", "order_id", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_events", "status", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_events", "canceled_reason", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("agentcard_events", "status_detail", "TEXT NOT NULL DEFAULT ''");

// ---------- offers: a price somebody could act on, written by code from what was really read ----------
//
// One row per offer READ: a live page (schema.org Product/Offer markup), an AgentCard search result,
// or an AgentCard cart. Every field is either what the source said or NULL with its name in
// `unverified` — never something the model remembered. `fetched_at` is when the source was read, which
// is what makes "current" checkable. Holds no card data and nothing about how anybody pays.
db.exec(`
  CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    source TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    product TEXT NOT NULL DEFAULT '',
    product_id TEXT NOT NULL DEFAULT '',
    seller TEXT NOT NULL DEFAULT '',
    price_cents INTEGER,
    currency TEXT NOT NULL DEFAULT '',
    stock TEXT NOT NULL DEFAULT '',
    shipping_cents INTEGER,
    shipping_time TEXT NOT NULL DEFAULT '',
    return_terms TEXT NOT NULL DEFAULT '',
    unverified TEXT NOT NULL DEFAULT '[]',
    buy_conversation_id TEXT NOT NULL DEFAULT '',
    fetched_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS offers_by_conv ON offers (conversation_id, fetched_at);
`);
// A cart link for the exact item, only where the merchant documents one (src/handoff.js). '' = none.
addColumnIfMissing("offers", "cart_url", "TEXT NOT NULL DEFAULT ''");

/** Write one offer record. Fields left null/empty are listed in `unverified` unless the caller already did. */
export function saveOffer(conversationId, offer) {
  const o = offer ?? {};
  const unverified = Array.isArray(o.unverified) ? o.unverified : [];
  const r = db.prepare(`INSERT INTO offers (conversation_id, source, url, product, product_id, seller, price_cents, currency, stock,
      shipping_cents, shipping_time, return_terms, unverified, buy_conversation_id, fetched_at, cart_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    conversationId, String(o.source ?? "page"), String(o.url ?? ""), String(o.product ?? "").slice(0, 500), String(o.product_id ?? ""),
    String(o.seller ?? ""), o.price_cents == null ? null : Math.round(o.price_cents), String(o.currency ?? ""), String(o.stock ?? ""),
    o.shipping_cents == null ? null : Math.round(o.shipping_cents), String(o.shipping_time ?? ""), String(o.return_terms ?? "").slice(0, 500),
    JSON.stringify(unverified), String(o.buy_conversation_id ?? ""), Number(o.fetched_at ?? clock.now()), String(o.cart_url ?? ""));
  return getOffer(conversationId, Number(r.lastInsertRowid));
}

/**
 * The offer a purchase is about, for a handoff when it cannot be bought: the one they picked when
 * there is one, else the newest record of AgentCard's own cart on that purchase. Theirs or nobody's.
 */
export function offerForBuy(conversationId, buyConversationId) {
  const p = db.prepare("SELECT offer_id FROM agentcard_purchases WHERE buy_conversation_id = ? AND conversation_id = ?").get(buyConversationId, conversationId);
  if (p?.offer_id) { const o = getOffer(conversationId, p.offer_id); if (o) return o; }
  const row = db.prepare("SELECT id FROM offers WHERE conversation_id = ? AND buy_conversation_id = ? AND source = 'agentcard_cart' ORDER BY fetched_at DESC, id DESC LIMIT 1").get(conversationId, buyConversationId);
  return row ? getOffer(conversationId, row.id) : null;
}

/** The prices offer_check read off exactly this page for them since `since` (cents), newest first. */
export function offerPricesFor(conversationId, url, since = 0) {
  if (!url) return [];
  return db.prepare("SELECT price_cents FROM offers WHERE conversation_id = ? AND url = ? AND source = 'page' AND price_cents IS NOT NULL AND fetched_at >= ? ORDER BY fetched_at DESC, id DESC")
    .all(conversationId, String(url), since).map(r => r.price_cents);
}

/** One offer, theirs or nobody's. `unverified` comes back as an array. */
export function getOffer(conversationId, id) {
  const row = db.prepare("SELECT * FROM offers WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
  if (!row) return null;
  let unverified = [];
  try { unverified = JSON.parse(row.unverified || "[]"); } catch { /* left empty */ }
  return { ...row, unverified };
}

/** A row as callers want it: tokens opened. The stored form never leaves this file. */
function openAgentcardRow(row) {
  if (!row) return null;
  return { ...row, access_token: secretbox.open(row.access_token), refresh_token: secretbox.open(row.refresh_token) };
}

/** How many stored AgentCard token rows are sealed vs plain text. Counts only; no values. */
export function agentcardTokenAudit() {
  const rows = db.prepare("SELECT access_token, refresh_token FROM agentcard_users WHERE access_token != '' OR refresh_token != ''").all();
  const sealed = rows.filter(r => [r.access_token, r.refresh_token].every(v => !v || secretbox.isSealed(v))).length;
  return { rows: rows.length, sealed, plain: rows.length - sealed };
}

/**
 * The token pair from one exchange, written against the person whose link it was.
 *
 * `exchanged_session` is set in the same write, so the claim and the tokens can never disagree.
 */
export function saveAgentcardConnection({ conversationId, userId, accessToken, refreshToken = "", expiresAt = null, sessionId = "", refreshed = false }) {
  // One statement, so the pair and the health columns can never disagree, and a pair that works
  // clears whatever was wrong before it.
  db.prepare(`UPDATE agentcard_users
    SET user_id = ?, access_token = ?, refresh_token = ?, token_expires_at = ?, exchanged_session = ?,
        linked_at = CASE WHEN ? THEN COALESCE(linked_at, ?) ELSE ? END, updated_at = ?,
        refreshed_at = CASE WHEN ? THEN ? ELSE refreshed_at END,
        refresh_failed_at = NULL, refresh_error = '', connection_dead_at = NULL
    WHERE conversation_id = ?`)
    // An exchange is a new link and moves `linked_at` (the "last linked" vault_enroll reports); a
    // refresh only renews it and leaves the date alone.
    .run(userId, secretbox.seal(accessToken), secretbox.seal(refreshToken), expiresAt, sessionId,
      refreshed ? 1 : 0, clock.now(), clock.now(), clock.now(),
      refreshed ? 1 : 0, clock.now(), conversationId);
  exchangingNow.delete(sessionId);
  return getAgentcardUser(conversationId);
}

/**
 * A refresh that answered with a new refresh token but nothing usable beside it. The old refresh
 * token is already dead at AgentCard, so the new one is the only way back in: it is kept, and the
 * access token is left as it is.
 */
export function saveAgentcardRefreshToken(conversationId, refreshToken) {
  if (!refreshToken) return getAgentcardUser(conversationId);
  db.prepare("UPDATE agentcard_users SET refresh_token = ?, updated_at = ? WHERE conversation_id = ?")
    .run(secretbox.seal(refreshToken), clock.now(), conversationId);
  return getAgentcardUser(conversationId);
}

/**
 * A refresh that did not go through. `dead` only when AgentCard refused the refresh token itself;
 * `error` is AgentCard's words, trimmed, never a token.
 */
export function noteAgentcardRefreshFailed(conversationId, { dead = false, error = "", at = clock.now() } = {}) {
  db.prepare(`UPDATE agentcard_users SET refresh_failed_at = ?, refresh_error = ?,
      connection_dead_at = CASE WHEN ? THEN COALESCE(connection_dead_at, ?) ELSE connection_dead_at END
    WHERE conversation_id = ?`)
    .run(at, String(error ?? "").slice(0, 200), dead ? 1 : 0, at, conversationId);
  return getAgentcardUser(conversationId);
}

/** Every connection that has ever been made — a user id or a token on the row. Tokens opened. */
export function listAgentcardConnections() {
  return db.prepare("SELECT * FROM agentcard_users WHERE user_id != '' OR access_token != '' OR refresh_token != '' ORDER BY conversation_id")
    .all().map(openAgentcardRow);
}

/**
 * Claim a vault session for exchanging, exactly once.
 *
 * The exchange is single use and `vault.session_linked` and `vault.card_stored` race to call it, as
 * can a tool polling at the same moment. Whoever flips this first does the exchange; everybody else
 * gets false and leaves it alone. Returns false for a session this machine never minted.
 */
export function claimAgentcardExchange(vaultSessionId) {
  if (!vaultSessionId) return false;
  const r = db.prepare(`UPDATE agentcard_users SET exchanged_session = ?, updated_at = ?
    WHERE vault_session_id = ? AND exchanged_session != ?`)
    .run(vaultSessionId, clock.now(), vaultSessionId, vaultSessionId);
  if (r.changes > 0) exchangingNow.add(vaultSessionId);
  return r.changes > 0;
}

// Claims taken by THIS process and not yet finished. A lost claim (`claimAgentcardExchange` false)
// is "somebody is connecting them right now" only while the winner is still in here; a claim from
// an exchange that finished long ago is a spent link, and its token may have died since.
const exchangingNow = new Set();
/** Is an exchange of this session running in this process right now? */
export function agentcardExchangeInFlight(vaultSessionId) { return exchangingNow.has(vaultSessionId); }

/** Hand a claim back when the exchange did not happen, so a later attempt is not locked out. */
export function releaseAgentcardExchange(vaultSessionId) {
  if (!vaultSessionId) return;
  exchangingNow.delete(vaultSessionId);
  db.prepare("UPDATE agentcard_users SET exchanged_session = '' WHERE vault_session_id = ? AND exchanged_session = ?")
    .run(vaultSessionId, vaultSessionId);
}

/** The vault session just minted for this person. One row per conversation; a new link replaces the old. */
export function startAgentcardEnrollment({ conversationId, vaultSessionId, url = "", expiresAt = "" }) {
  db.prepare(`INSERT INTO agentcard_users (conversation_id, vault_session_id, session_url, session_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      vault_session_id = excluded.vault_session_id,
      session_url = excluded.session_url,
      session_expires_at = excluded.session_expires_at,
      updated_at = excluded.updated_at`)
    .run(conversationId, vaultSessionId, url, expiresAt, clock.now(), clock.now());
  return getAgentcardUser(conversationId);
}

/**
 * The user id AgentCard gave back, written against whoever the session was minted for.
 *
 * Found by the session id rather than taken on the event's word about who it belongs to: that is the
 * only thing tying a `vault.session_linked` to a person, because the link was sent to one person and
 * nothing else in the payload says which. An event for a session this machine never minted writes
 * nothing and returns null.
 */
export function linkAgentcardUser({ vaultSessionId, userId, at = clock.now() }) {
  const row = db.prepare("SELECT * FROM agentcard_users WHERE vault_session_id = ?").get(vaultSessionId) ?? null;
  if (!row) return null;
  db.prepare("UPDATE agentcard_users SET user_id = ?, linked_at = ?, updated_at = ? WHERE conversation_id = ?")
    .run(userId, at, at, row.conversation_id);
  return getAgentcardUser(row.conversation_id);
}

/** Brand and last four of a card that landed. Never a number — AgentCard does not send one. */
export function noteAgentcardCard({ userId, brand = "", last4 = "" }) {
  const row = agentcardUserById(userId);
  if (!row) return null;
  db.prepare("UPDATE agentcard_users SET card_brand = ?, card_last4 = ?, updated_at = ? WHERE conversation_id = ?")
    .run(brand, last4, clock.now(), row.conversation_id);
  return getAgentcardUser(row.conversation_id);
}

export function getAgentcardUser(conversationId) {
  return openAgentcardRow(db.prepare("SELECT * FROM agentcard_users WHERE conversation_id = ?").get(conversationId));
}

/** Whose Reason an AgentCard user id belongs to. How a webhook finds the person to tell. */
export function agentcardUserById(userId) {
  if (!userId) return null;
  return openAgentcardRow(db.prepare("SELECT * FROM agentcard_users WHERE user_id = ? AND user_id != ''").get(userId));
}

/** One purchase conversation, created or brought up to date with the turn that just came back. */
export function recordAgentcardPurchase({ conversationId, buyConversationId, status, cartHash = "", amountCents = 0, merchant = "", what = "" }) {
  db.prepare(`INSERT INTO agentcard_purchases
      (conversation_id, buy_conversation_id, status, cart_hash, amount_cents, merchant, what, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(buy_conversation_id) DO UPDATE SET
      status = excluded.status,
      cart_hash = excluded.cart_hash,
      amount_cents = excluded.amount_cents,
      merchant = excluded.merchant,
      what = excluded.what,
      updated_at = excluded.updated_at,
      -- A different cart on the same conversation (they changed the item, the address, the count; or
      -- a 409 handed back a fresh one) is a fresh attempt: the store's refusals of the OLD cart and the
      -- approval that was spent on it do not carry over, or a cart nobody has tried would be said to
      -- have been rejected, and after two it would never be sent at all. The same hash keeps them, and
      -- so does a clarifying turn with no cart yet (hash ''). The old cart's decline code goes too, or a
      -- card decline on cart A would be the blame for cart B's refusals.
      placement_failures = CASE WHEN (excluded.cart_hash != '' AND excluded.cart_hash != agentcard_purchases.cart_hash) THEN 0 ELSE agentcard_purchases.placement_failures END,
      placement_failed_at = CASE WHEN (excluded.cart_hash != '' AND excluded.cart_hash != agentcard_purchases.cart_hash) THEN NULL ELSE agentcard_purchases.placement_failed_at END,
      placement_fail_code = CASE WHEN (excluded.cart_hash != '' AND excluded.cart_hash != agentcard_purchases.cart_hash) THEN '' ELSE agentcard_purchases.placement_fail_code END,
      placement_fail_reason = CASE WHEN (excluded.cart_hash != '' AND excluded.cart_hash != agentcard_purchases.cart_hash) THEN '' ELSE agentcard_purchases.placement_fail_reason END,
      authorization_state = CASE WHEN (excluded.cart_hash != '' AND excluded.cart_hash != agentcard_purchases.cart_hash) THEN '' ELSE agentcard_purchases.authorization_state END,
      authorization_id = CASE WHEN (excluded.cart_hash != '' AND excluded.cart_hash != agentcard_purchases.cart_hash) THEN '' ELSE agentcard_purchases.authorization_id END,
      decline_code = CASE WHEN (excluded.cart_hash != '' AND excluded.cart_hash != agentcard_purchases.cart_hash) THEN '' ELSE agentcard_purchases.decline_code END
    -- Never rewrites another person's purchase row, whatever buy_conversation_id came back (isolation 11-09).
    WHERE agentcard_purchases.conversation_id = excluded.conversation_id`)
    .run(conversationId, buyConversationId, status, cartHash, Math.round(amountCents), merchant, what, clock.now(), clock.now());
  return getAgentcardPurchase(buyConversationId);
}

/**
 * Where a purchase got to. Only the fields passed are written, so a webhook that knows the
 * authorization and nothing else cannot blank the order id a confirm already recorded.
 */
export function markAgentcardPurchase(buyConversationId, patch = {}) {
  const row = getAgentcardPurchase(buyConversationId);
  if (!row) return null;
  const sets = [];
  const vals = [];
  const put = (col, v) => { if (v !== undefined && v !== null) { sets.push(`${col} = ?`); vals.push(restcrypt.sealCell("agentcard_purchases", col, row.conversation_id, v)); } };
  put("status", patch.status);
  put("cart_hash", patch.cartHash);
  put("order_id", patch.orderId);
  put("decline_code", patch.declineCode);
  put("charge_status", patch.chargeStatus);
  put("authorization_id", patch.authorizationId);
  put("confirmation_id", patch.confirmationId);
  put("authorization_state", patch.authorizationState);
  put("order_state", patch.orderState);
  put("address_json", patch.addressJson);
  put("offer_id", patch.offerId);
  put("offer_match", patch.offerMatch);
  put("cart_json", patch.cartJson);
  put("retailer_order_id", patch.retailerOrderId);
  put("delivery_window", patch.deliveryWindow);
  put("kind", patch.kind);
  put("flight_json", patch.flightJson);
  put("traveler_ids", patch.travelerIds);
  put("traveler_fp", patch.travelerFp);
  put("quote_checked_at", patch.quoteCheckedAt);
  put("approval_expires_at", patch.approvalExpiresAt);
  put("ticketing_state", patch.ticketingState);
  if (patch.amountCents !== undefined && patch.amountCents !== null) { sets.push("amount_cents = ?"); vals.push(Math.round(patch.amountCents)); }
  if (!sets.length) return row;
  sets.push("updated_at = ?");
  vals.push(clock.now(), buyConversationId);
  db.prepare(`UPDATE agentcard_purchases SET ${sets.join(", ")} WHERE buy_conversation_id = ?`).run(...vals);
  if (patch.status === "placed" || patch.ticketingState === "issued") emitCompletion("purchase", { buyConversationId });
  return getAgentcardPurchase(buyConversationId);
}

/**
 * Why an order was cancelled, kept on its purchase: AgentCard's code and the store's line. Each is
 * written only while the row has none, so a later copy of the event, or a later event, that carries
 * null — or nothing — never erases a reason already kept. Empty values write nothing.
 */
export function noteAgentcardCancelReason(buyConversationId, { code = "", detail = "" } = {}) {
  if (!buyConversationId) return getAgentcardPurchase(buyConversationId);
  const c = String(code ?? "").trim();
  const d = String(detail ?? "").trim();
  if (c) db.prepare("UPDATE agentcard_purchases SET cancel_reason = ?, updated_at = ? WHERE buy_conversation_id = ? AND cancel_reason = ''").run(c.slice(0, 200), clock.now(), buyConversationId);
  if (d) db.prepare("UPDATE agentcard_purchases SET cancel_detail = ?, updated_at = ? WHERE buy_conversation_id = ? AND cancel_detail = ''").run(d.slice(0, 500), clock.now(), buyConversationId);
  return getAgentcardPurchase(buyConversationId);
}

/**
 * The store refused to place this cart after the person had approved the payment (an `order.failed`
 * with no order_id, matched to the purchase by its buy conversation). Counted, and the latest code and
 * reason kept — a later event with no reason never erases one already kept.
 */
export function noteAgentcardPlacementFailure(buyConversationId, { code = "", reason = "" } = {}) {
  if (!buyConversationId) return null;
  const c = String(code ?? "").trim().slice(0, 100);
  const r = String(reason ?? "").trim().slice(0, 500);
  db.prepare(`UPDATE agentcard_purchases SET placement_failures = placement_failures + 1, placement_failed_at = ?,
      placement_fail_code = CASE WHEN ? != '' THEN ? ELSE placement_fail_code END,
      placement_fail_reason = CASE WHEN ? != '' THEN ? ELSE placement_fail_reason END,
      updated_at = ? WHERE buy_conversation_id = ?`)
    .run(clock.now(), c, c, r, r, clock.now(), buyConversationId);
  return getAgentcardPurchase(buyConversationId);
}

/**
 * The one chance to tell somebody their order was cancelled. True for exactly one caller per
 * purchase: a redelivered event, a second order.* event and a purchase_track read all race for it,
 * and only the first gets to say anything.
 */
export function claimAgentcardCancelNotice(buyConversationId) {
  if (!buyConversationId) return false;
  return db.prepare("UPDATE agentcard_purchases SET cancel_told_at = ? WHERE buy_conversation_id = ? AND cancel_told_at IS NULL")
    .run(clock.now(), buyConversationId).changes === 1;
}

/**
 * The first whole record seen of a flight's order, kept as it came (once: a later, thinner copy never
 * replaces it). What a placed flight order carries has never been seen; this is where it is read from.
 */
export function keepAgentcardOrderRaw(buyConversationId, raw) {
  if (!buyConversationId || !raw || typeof raw !== "object") return;
  db.prepare("UPDATE agentcard_purchases SET order_raw_json = ?, updated_at = ? WHERE buy_conversation_id = ? AND kind = 'flight' AND order_raw_json = ''")
    .run(JSON.stringify(raw).slice(0, 20_000), clock.now(), buyConversationId);
}

export function getAgentcardPurchase(buyConversationId) {
  return db.prepare("SELECT * FROM agentcard_purchases WHERE buy_conversation_id = ?").get(buyConversationId) ?? null;
}

/**
 * The purchase a `checkout_authorization.*` event is about, by AgentCard's authorization id and
 * nothing else.
 *
 * Until 2026-10-23 this matched on the person plus the amount (and fell back to their newest purchase
 * waiting at all), which could attach one cart's approval or decline to another. The id comes from
 * the approval link the confirm returned (agentcard.authorizationIdFrom) and is stored on the row when
 * it goes to awaiting_approval. No id, no match: the event is logged and the row is left alone.
 */
export function agentcardPurchaseByAuthorization(authorizationId) {
  if (!authorizationId) return null;
  return db.prepare("SELECT * FROM agentcard_purchases WHERE authorization_id = ? AND authorization_id != ''").get(authorizationId) ?? null;
}

export function listAgentcardPurchases(conversationId, limit = 20) {
  return db.prepare("SELECT * FROM agentcard_purchases WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(conversationId, limit);
}

/**
 * The purchases that ride on every turn (src/purchasesnote.js): this person's, touched since `since`,
 * newest first. A `shopping` row with no cart is somebody browsing, not a purchase, and is left out.
 */
export function recentAgentcardPurchases(conversationId, { since = 0, limit = 5 } = {}) {
  return db.prepare(`SELECT * FROM agentcard_purchases
    WHERE conversation_id = ? AND MAX(created_at, updated_at) >= ? AND NOT (status = 'shopping' AND cart_hash = '')
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(conversationId, since, limit);
}

export function agentcardPurchaseByOrder(orderId) {
  if (!orderId) return null;
  return db.prepare("SELECT * FROM agentcard_purchases WHERE order_id = ? AND order_id != ''").get(orderId) ?? null;
}

/**
 * Has this webhook already been handled? AgentCard delivers at least once and retries five times, so
 * the id is the dedupe key — without it a retried `vault.card_stored` would text somebody twice.
 * Returns true the first time an id is seen and false every time after.
 */
export function firstAgentcardEvent({ eventId, type = "", data = null }) {
  if (!eventId) return true;
  // What the first copy said about the order, kept per event id. A later copy of the same id is
  // ignored whole (AgentCard's own advice, 2026-10-24: the first copy is authoritative).
  const d = data && typeof data === "object" ? data : {};
  const s = (v) => (v == null ? "" : String(v)).slice(0, 500);
  const r = db.prepare(`INSERT OR IGNORE INTO agentcard_events (event_id, type, received_at, order_id, status, canceled_reason, status_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(eventId, type, clock.now(), s(d.order_id), s(d.status), s(d.canceled_reason), s(d.status_detail));
  return r.changes > 0;
}

/** The first copy of one AgentCard event, as kept by firstAgentcardEvent. null for an id never seen. */
export function agentcardEvent(eventId) {
  if (!eventId) return null;
  return db.prepare("SELECT * FROM agentcard_events WHERE event_id = ?").get(eventId) ?? null;
}

// ---------- uber rides ----------
//
// One row per QUOTE, which is also what becomes one row per ride. It exists for the same reason
// `agentcard_purchases` does, and the reason is the confirm gate: the yes has to be pinned to the
// ride that was really described, read back out of a table rather than retyped by the model. See
// confirmTargetFor in src/tools.js.
//
// There is a second job only this table can do, and it is the one that makes an Uber harder than a
// cart. **An Uber upfront fare expires after two minutes** (Uber's own sentence, in their
// best-practices page), so the fare_id a person was quoted is dead long before they have read the
// text and answered. What does NOT expire is the route, the product and the total — so that is what
// the row holds and what the yes is pinned to, and `uber_request` fetches a fresh fare_id for the
// same route at the moment it books. A fresh total that is not the agreed total means nothing is
// booked and they are asked again. `fare_id` and `fare_expires_at` are on the row anyway, because
// "the quote you were given had already expired" is a thing the ledger should be able to say.
//
// `status` tracks where it got to:
//   quoted           — a fare was shown and the person can be asked. Nothing has happened.
//   requested        — Uber has the request. Somebody is being driven, or will be.
//   outcome_unknown  — the request went out and nothing came back. See trust.retryBlocked.
//   cancelled        — cancelled through Reason.
//   failed           — Uber refused it, and `uber_code` says what they said.
// `uber_status` is Uber's own word for the trip (processing, accepted, arriving, …), kept separate
// because "did Reason book this" and "where is the car" are different questions.
db.exec(`
  CREATE TABLE IF NOT EXISTS uber_rides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    quote_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    product_id TEXT NOT NULL DEFAULT '',
    product_name TEXT NOT NULL DEFAULT '',
    start_latitude REAL,
    start_longitude REAL,
    start_place_id TEXT NOT NULL DEFAULT '',
    start_label TEXT NOT NULL DEFAULT '',
    end_latitude REAL,
    end_longitude REAL,
    end_place_id TEXT NOT NULL DEFAULT '',
    end_label TEXT NOT NULL DEFAULT '',
    fare_id TEXT NOT NULL DEFAULT '',
    fare_cents INTEGER NOT NULL DEFAULT 0,
    fare_display TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT '',
    fare_expires_at INTEGER,
    surge_multiplier REAL NOT NULL DEFAULT 1,
    request_id TEXT NOT NULL DEFAULT '',
    uber_status TEXT NOT NULL DEFAULT '',
    uber_code TEXT NOT NULL DEFAULT '',
    confirmation_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS uber_rides_by_conv ON uber_rides (conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS uber_rides_by_request ON uber_rides (request_id);
`);

/** A quote, written the moment one is shown. `quoteId` is Reason's own id, not Uber's. */
export function recordUberQuote({
  conversationId, quoteId, productId = "", productName = "",
  start = {}, end = {}, fareId = "", fareCents = 0, fareDisplay = "", currency = "",
  fareExpiresAt = null, surgeMultiplier = 1,
}) {
  const now = clock.now();
  db.prepare(`INSERT INTO uber_rides
      (conversation_id, quote_id, status, product_id, product_name,
       start_latitude, start_longitude, start_place_id, start_label,
       end_latitude, end_longitude, end_place_id, end_label,
       fare_id, fare_cents, fare_display, currency, fare_expires_at, surge_multiplier,
       created_at, updated_at)
    VALUES (?, ?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(quote_id) DO UPDATE SET
      status = 'quoted',
      fare_id = excluded.fare_id,
      fare_cents = excluded.fare_cents,
      fare_display = excluded.fare_display,
      currency = excluded.currency,
      fare_expires_at = excluded.fare_expires_at,
      surge_multiplier = excluded.surge_multiplier,
      updated_at = excluded.updated_at
    WHERE uber_rides.conversation_id = excluded.conversation_id`)
    .run(
      conversationId, quoteId, productId, productName,
      start.latitude ?? null, start.longitude ?? null, String(start.place_id ?? ""), String(start.label ?? ""),
      end.latitude ?? null, end.longitude ?? null, String(end.place_id ?? ""), String(end.label ?? ""),
      fareId, Math.round(fareCents), fareDisplay, currency, fareExpiresAt, Number(surgeMultiplier) || 1,
      now, now,
    );
  return getUberRide(quoteId);
}

/**
 * Where a ride got to. Only the fields passed are written, so a status poll that knows the trip
 * state and nothing else cannot blank the request id the booking recorded.
 */
export function markUberRide(quoteId, patch = {}) {
  const row = getUberRide(quoteId);
  if (!row) return null;
  const sets = [];
  const vals = [];
  const put = (col, v) => { if (v !== undefined && v !== null) { sets.push(`${col} = ?`); vals.push(v); } };
  put("status", patch.status);
  put("request_id", patch.requestId);
  put("uber_status", patch.uberStatus);
  put("uber_code", patch.uberCode);
  put("fare_id", patch.fareId);
  put("fare_display", patch.fareDisplay);
  put("fare_expires_at", patch.fareExpiresAt);
  put("confirmation_id", patch.confirmationId);
  if (patch.fareCents !== undefined && patch.fareCents !== null) { sets.push("fare_cents = ?"); vals.push(Math.round(patch.fareCents)); }
  if (!sets.length) return row;
  sets.push("updated_at = ?");
  vals.push(clock.now(), quoteId);
  db.prepare(`UPDATE uber_rides SET ${sets.join(", ")} WHERE quote_id = ?`).run(...vals);
  return getUberRide(quoteId);
}

export function getUberRide(quoteId) {
  return db.prepare("SELECT * FROM uber_rides WHERE quote_id = ?").get(String(quoteId ?? "")) ?? null;
}

/**
 * The ride this person has going, if any.
 *
 * Scoped by conversation, like every other read here: `uber_ride` and `uber_cancel` find the ride
 * from this and never from an id the model typed, so one person's ride is not reachable from
 * another person's thread.
 */
export function liveUberRide(conversationId) {
  return db.prepare(`SELECT * FROM uber_rides
    WHERE conversation_id = ? AND status = 'requested' AND request_id != ''
    ORDER BY updated_at DESC, id DESC LIMIT 1`).get(conversationId) ?? null;
}

/** The newest ride of theirs that reached Uber at all, cancelled or finished included. */
export function lastUberRide(conversationId) {
  return db.prepare(`SELECT * FROM uber_rides
    WHERE conversation_id = ? AND request_id != ''
    ORDER BY updated_at DESC, id DESC LIMIT 1`).get(conversationId) ?? null;
}

export function listUberRides(conversationId, limit = 20) {
  return db.prepare("SELECT * FROM uber_rides WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(conversationId, limit);
}

// ---------- noticing things first ----------
//
// Everything in here is bookkeeping with no judgement in it. What is worth saying is the model's;
// what has already been said, how many times somebody has been interrupted today, and what their
// calendar looked like two hours ago are facts, and a fact Reason has to be right about belongs in
// a table rather than in a sentence it wrote.

/** Where this person's sweep got to, created on first read so callers never have to. */
export function noticeSweep(conversationId) {
  const row = db.prepare("SELECT * FROM notice_sweeps WHERE conversation_id = ?").get(conversationId);
  if (row) return row;
  db.prepare("INSERT OR IGNORE INTO notice_sweeps (conversation_id, runs) VALUES (?, 0)").run(conversationId);
  return db.prepare("SELECT * FROM notice_sweeps WHERE conversation_id = ?").get(conversationId);
}

/** Move the high-water mark on. Called whether or not anything was said: a look is a look. */
export function markNoticeSwept(conversationId, { at = clock.now(), timeZone = null } = {}) {
  noticeSweep(conversationId);
  db.prepare(`UPDATE notice_sweeps SET last_at = ?, runs = runs + 1${timeZone === null ? "" : ", time_zone = ?"}
    WHERE conversation_id = ?`)
    .run(...(timeZone === null ? [at, conversationId] : [at, timeZone, conversationId]));
  return noticeSweep(conversationId);
}

/** The same mark for the follow-on pass, which asks a different question of a different window. */
export function markFollowOnSwept(conversationId, at = clock.now()) {
  noticeSweep(conversationId);
  db.prepare("UPDATE notice_sweeps SET last_follow_on_at = ? WHERE conversation_id = ?").run(at, conversationId);
}

/** Their next couple of days as the last sweep saw them. */
export function noticeEvents(conversationId) {
  return db.prepare("SELECT * FROM notice_events WHERE conversation_id = ?").all(conversationId)
    .map(r => ({ ...r, attendees: safeJson(r.attendees, []) }));
}

/**
 * Replace the snapshot for one account with what the calendar says now.
 *
 * Per account rather than per person, because a read that failed on their work calendar must not
 * look like every work event being cancelled. Only the account that really answered is replaced.
 */
export function putNoticeEvents(conversationId, account, events, at = clock.now()) {
  db.prepare("DELETE FROM notice_events WHERE conversation_id = ? AND account = ?").run(conversationId, account);
  const ins = db.prepare(`INSERT OR REPLACE INTO notice_events
    (conversation_id, account, event_id, summary, start, end_at, status, attendees, time_zone, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const e of events) {
    ins.run(conversationId, account, String(e.id), String(e.summary ?? ""), String(e.start ?? ""),
      String(e.end ?? ""), String(e.status ?? ""), seal2(conversationId, JSON.stringify(e.attendees ?? [])), String(e.time_zone ?? ""), at);
  }
  return events.length;
}

/**
 * Write a candidate down, once. Returns the row, and `fresh` false when this exact thing in this
 * exact state has been raised before — which is what stops the same moved meeting being news on
 * every sweep for two days.
 */
export function recordNotice(conversationId, {
  kind, key, what = "", detail = "", momentAt = null, urgent = false, at = clock.now(),
  thing = "", account = "", threadId = "", eventId = "", state = "", source = "", momentWhy = "",
}) {
  const existing = db.prepare("SELECT * FROM notice_seen WHERE conversation_id = ? AND kind = ? AND key = ?")
    .get(conversationId, kind, String(key));
  if (existing) return { ...existing, fresh: false };
  db.prepare(`INSERT INTO notice_seen
      (conversation_id, kind, key, what, detail, moment_at, first_seen, urgent, thing, account, thread_id, event_id, state, source, moment_why)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, kind, String(key), what, detail, momentAt, at, urgent ? 1 : 0,
      String(thing || key), account, threadId, eventId, String(state ?? ""), String(source ?? "").slice(0, 400),
      String(momentWhy ?? "").slice(0, 300));
  return { ...getNotice(conversationId, key, kind), fresh: true };
}

/**
 * Already handled, so nothing is said. The fourth outcome, and the only one that is a success with
 * no text in it: their calendar already had the new time, the reply had gone, the bill had been read.
 */
export function resolveNotice(id, why, at = clock.now()) {
  db.prepare("UPDATE notice_seen SET resolved_at = ?, resolved_why = ? WHERE id = ? AND said_at IS NULL")
    .run(at, String(why ?? "").slice(0, 300), id);
  return noticeById(id);
}

export function forgetNotice(id) {
  const row = noticeById(id);
  if (!row) return null;
  db.prepare("DELETE FROM notice_seen WHERE id = ?").run(id);
  return row;
}

/** Noticed, checked, already handled. What "have you noticed anything" has to be honest about. */
export function resolvedNotices(conversationId, { limit = 5 } = {}) {
  return db.prepare(`SELECT * FROM notice_seen WHERE conversation_id = ? AND resolved_at IS NOT NULL
    ORDER BY resolved_at DESC LIMIT ?`).all(conversationId, limit);
}

/** Checked and not settled either way. Carried into the frame, and a bar on claiming it is urgent. */
export function markNoticeUnclear(id, why) {
  db.prepare("UPDATE notice_seen SET unclear = ? WHERE id = ?").run(String(why ?? "").slice(0, 300), id);
  return noticeById(id);
}

/**
 * The last time this exact THING — the thread, the event, not the state it was in — was really
 * said. "One nudge per thing, then it waits for them" is this row compared against the last time
 * they said anything at all.
 */
export function lastNudgeForThing(conversationId, thing) {
  if (!thing) return null;
  return db.prepare(`SELECT * FROM notice_seen WHERE conversation_id = ? AND thing = ? AND said_at IS NOT NULL
    ORDER BY said_at DESC LIMIT 1`).get(conversationId, String(thing)) ?? null;
}

/** When they last said anything. A nudge waits on this, and never on another nudge. */
export function lastInboundAt(conversationId) {
  const row = db.prepare("SELECT MAX(received_at) AS at FROM inbound_messages WHERE conversation_id = ?")
    .get(conversationId);
  return Number(row?.at ?? 0) || 0;
}

/** Catches parked on their own timer and not yet said. What "stop" has to be able to take back. */
export function parkedNotices(conversationId) {
  return db.prepare(`SELECT * FROM notice_seen WHERE conversation_id = ? AND timer_id IS NOT NULL
    AND said_at IS NULL AND resolved_at IS NULL ORDER BY moment_at ASC`).all(conversationId);
}

/** Let a parked catch go: the timer is cancelled by the caller, the row goes back to being held. */
export function unparkNotice(id, at = clock.now()) {
  db.prepare("UPDATE notice_seen SET timer_id = NULL, held_at = ? WHERE id = ?").run(at, id);
  return noticeById(id);
}

export function getNotice(conversationId, key, kind = null) {
  return db.prepare(`SELECT * FROM notice_seen WHERE conversation_id = ? AND key = ?${kind ? " AND kind = ?" : ""}
    ORDER BY id DESC LIMIT 1`).get(...(kind ? [conversationId, String(key), kind] : [conversationId, String(key)])) ?? null;
}

export function noticeById(id) {
  return db.prepare("SELECT * FROM notice_seen WHERE id = ?").get(id) ?? null;
}

/** The notice a one-off timer was scheduled for, if that timer belongs to one. */
export function noticeByTimer(timerId) {
  return db.prepare("SELECT * FROM notice_seen WHERE timer_id = ?").get(timerId) ?? null;
}

/**
 * A sweep wanted to raise this and code said no. Recorded rather than dropped, because the thing is
 * still true: it goes first on the next sweep and folds into the next reply they are already reading.
 */
export function holdNotice(id, at = clock.now()) {
  db.prepare("UPDATE notice_seen SET held_at = ?, holds = holds + 1 WHERE id = ? AND said_at IS NULL").run(at, id);
  return noticeById(id);
}

/** A sweep turn had this in front of the model and nothing was said about it. See 'offered' above. */
export function markNoticeOffered(id, at = clock.now()) {
  db.prepare("UPDATE notice_seen SET offered = offered + 1, offered_at = ? WHERE id = ? AND said_at IS NULL").run(at, id);
  return noticeById(id);
}

/** Their digest went out for this local day. Keyed by the day so a late pass is still that day's. */
export function markDigestDay(conversationId, day) {
  noticeSweep(conversationId);
  db.prepare("UPDATE notice_sweeps SET last_digest_day = ? WHERE conversation_id = ?").run(String(day), conversationId);
  return noticeSweep(conversationId);
}

export function markRhythmDay(conversationId, day) {
  noticeSweep(conversationId);
  db.prepare("UPDATE notice_sweeps SET last_rhythm_day = ? WHERE conversation_id = ?").run(String(day), conversationId);
  return noticeSweep(conversationId);
}

/** Things still true, never said, oldest first. What the next sweep raises and the next reply folds in. */
/**
 * Newest first (2026-10-13). The ride-along on a reply they are already reading gets ONE of these,
 * and at 12:56am it offered a webinar mail from days ago while the invite found five minutes
 * earlier sat behind it. What was found last is what is most likely still true.
 */
export function heldNotices(conversationId, { limit = 5 } = {}) {
  return db.prepare(`SELECT * FROM notice_seen WHERE conversation_id = ? AND said_at IS NULL AND claimed_at IS NULL
    AND held_at IS NOT NULL AND timer_id IS NULL AND resolved_at IS NULL AND dropped_at IS NULL
    ORDER BY urgent DESC, first_seen DESC LIMIT ?`)
    .all(conversationId, limit);
}

/** What was really said, newest first. "Why haven't you told me anything" is answered from this. */
export function noticesSaid(conversationId, { since = null, limit = 10 } = {}) {
  return db.prepare(`SELECT * FROM notice_seen WHERE conversation_id = ? AND said_at IS NOT NULL
    ${since ? "AND said_at >= ?" : ""} ORDER BY said_at DESC LIMIT ?`)
    .all(...(since ? [conversationId, since, limit] : [conversationId, limit]));
}

/**
 * The model says this one is worth sending. Claimed, not sent: `said_at` and the budget both wait
 * until the text has really gone out (see `_turn` in src/runtime.js). Returns false when somebody
 * else already claimed or spent this key, so two overlapping sweeps cannot both take it.
 */
export function claimNotice(id, { urgent = false, whyNow = "", what = "" } = {}) {
  const r = db.prepare(`UPDATE notice_seen SET claimed_at = ?, urgent = ?, why_now = ?, what = ?
    WHERE id = ? AND said_at IS NULL AND claimed_at IS NULL`)
    .run(clock.now(), urgent ? 1 : 0, String(whyNow).slice(0, 300), String(what).slice(0, 500), id);
  return Number(r.changes) === 1;
}

/** The claim this conversation has open right now, if any. */
export function pendingNotice(conversationId) {
  return db.prepare(`SELECT * FROM notice_seen WHERE conversation_id = ? AND claimed_at IS NOT NULL AND said_at IS NULL
    AND dropped_at IS NULL ORDER BY claimed_at DESC LIMIT 1`).get(conversationId) ?? null;
}

/**
 * This heads-up is not worth saying any more: the job it was riding on was called off.
 *
 * Not deleted — the row is also the record that this thing was already seen, and deleting it would
 * let the same moved meeting come back round as news on the next sweep.
 */
export function dropNotice(id, at = clock.now()) {
  db.prepare("UPDATE notice_seen SET dropped_at = ? WHERE id = ? AND said_at IS NULL").run(at, id);
  return noticeById(id);
}

/** The text went. Now it is told, and now — not before — it costs them a day's allowance. */
export function markNoticeSaid(conversationId, { day, free = false } = {}) {
  const row = pendingNotice(conversationId);
  if (!row) return null;
  db.prepare("UPDATE notice_seen SET said_at = ?, claimed_at = NULL WHERE id = ?").run(clock.now(), row.id);
  if (!free) bumpNoticeBudget(conversationId, day, { urgent: !!row.urgent });
  return noticeById(row.id);
}

/** Nothing was sent, so nothing was heard: the claim goes back and the thing stays held. */
export function dropNoticeClaim(conversationId) {
  const row = pendingNotice(conversationId);
  if (!row) return null;
  db.prepare("UPDATE notice_seen SET claimed_at = NULL, held_at = ?, holds = holds + 1 WHERE id = ?")
    .run(clock.now(), row.id);
  return noticeById(row.id);
}

/** What today has cost them. `day` is their own local day, so this resets at their midnight. */
export function noticeBudget(conversationId, day) {
  return db.prepare("SELECT * FROM notice_budget WHERE conversation_id = ? AND day = ?").get(conversationId, day)
    ?? { conversation_id: conversationId, day, sent: 0, urgent: 0 };
}

export function bumpNoticeBudget(conversationId, day, { urgent = false } = {}) {
  db.prepare(`INSERT INTO notice_budget (conversation_id, day, sent, urgent) VALUES (?, ?, 1, ?)
    ON CONFLICT(conversation_id, day) DO UPDATE SET sent = sent + 1, urgent = urgent + ?`)
    .run(conversationId, day, urgent ? 1 : 0, urgent ? 1 : 0);
  return noticeBudget(conversationId, day);
}

/** The one-off timer a scheduled catch rides out on, tied back to the row that owns it. */
export function scheduleNotice(id, timerId, momentAt) {
  db.prepare("UPDATE notice_seen SET timer_id = ?, moment_at = ?, claimed_at = NULL WHERE id = ?")
    .run(timerId, momentAt, id);
  return noticeById(id);
}

/** Their own "text me less" / "check more often", or null for the install's default. */
export function noticePrefs(conversationId) {
  const row = db.prepare(`SELECT notice_per_day, notice_every_min, notice_mode, notice_snooze_until, notice_digest_hour,
      notice_tz, notice_window_start, notice_window_end, notice_window_asked_at, notice_window_answered_at,
      patterns, patterns_said, patterns_asked_at, patterns_set_at
    FROM accounts WHERE conversation_id = ?`).get(conversationId);
  return {
    perDay: row?.notice_per_day ?? null,
    everyMin: row?.notice_every_min ?? null,
    mode: row?.notice_mode ?? null,
    snoozeUntil: row?.notice_snooze_until ?? null,
    digestHour: row?.notice_digest_hour ?? null,
    tz: row?.notice_tz || "",
    windowStart: row?.notice_window_start ?? null,
    windowEnd: row?.notice_window_end ?? null,
    windowAskedAt: row?.notice_window_asked_at ?? null,
    windowAnsweredAt: row?.notice_window_answered_at ?? null,
    patterns: row?.patterns ?? null,
    patternsSaid: row?.patterns_said || "",
    patternsAskedAt: row?.patterns_asked_at ?? null,
    patternsSetAt: row?.patterns_set_at ?? null,
  };
}

export function setNoticePrefs(conversationId, { perDay, everyMin, mode, snoozeUntil, digestHour } = {}) {
  const set = (col, v) => db.prepare(`UPDATE accounts SET ${col} = ? WHERE conversation_id = ?`).run(v, conversationId);
  if (perDay !== undefined) set("notice_per_day", perDay);
  if (everyMin !== undefined) set("notice_every_min", everyMin);
  if (mode !== undefined) set("notice_mode", mode);
  if (snoozeUntil !== undefined) set("notice_snooze_until", snoozeUntil);
  if (digestHour !== undefined) set("notice_digest_hour", digestHour);
  return noticePrefs(conversationId);
}

/** Their own no-call hours for calls to other people: `{ hours: null | "off" | "HH:MM-HH:MM", said, setAt }`. */
export function callHours(conversationId) {
  const row = db.prepare("SELECT call_hours, call_hours_said, call_hours_set_at FROM accounts WHERE conversation_id = ?").get(conversationId);
  return { hours: row?.call_hours ?? null, said: row?.call_hours_said || "", setAt: row?.call_hours_set_at ?? null };
}

export function setCallHours(conversationId, { hours = null, said = "", at = Date.now() } = {}) {
  db.prepare("UPDATE accounts SET call_hours = ?, call_hours_said = ?, call_hours_set_at = ? WHERE conversation_id = ?")
    .run(hours, String(said ?? "").trim().slice(0, 300), at, conversationId);
  return callHours(conversationId);
}

export function setPatterns(conversationId, { patterns, said, askedAt, setAt } = {}) {
  const set = (col, v) => db.prepare(`UPDATE accounts SET ${col} = ? WHERE conversation_id = ?`).run(v, conversationId);
  if (patterns !== undefined) set("patterns", patterns);
  if (said !== undefined) set("patterns_said", String(said ?? "").trim());
  if (askedAt !== undefined) set("patterns_asked_at", askedAt);
  if (setAt !== undefined) set("patterns_set_at", setAt);
  return noticePrefs(conversationId);
}

/**
 * Their zone and their waking hours. `askedAt` is stamped when the question goes out so it can
 * never go out a second time; `answeredAt` is stamped only when they really said something, which
 * is the difference between "they chose 09:00-21:00" and "nobody has ever been asked".
 */
export function setNoticeWindow(conversationId, { tz, start, end, askedAt, answeredAt } = {}) {
  const set = (col, v) => db.prepare(`UPDATE accounts SET ${col} = ? WHERE conversation_id = ?`).run(v, conversationId);
  if (tz !== undefined) set("notice_tz", tz);
  if (start !== undefined) set("notice_window_start", start);
  if (end !== undefined) set("notice_window_end", end);
  if (askedAt !== undefined) set("notice_window_asked_at", askedAt);
  if (answeredAt !== undefined) set("notice_window_answered_at", answeredAt);
  return noticePrefs(conversationId);
}

/**
 * Tasks that finished since the mark: what the follow-on pass asks "and now what?" about.
 *
 * `>=` rather than `>`, which looks like an off-by-one and is not. A sweep stamps its mark off the
 * same clock a task stamps its finish, so a task that finished in the very millisecond a sweep ran
 * would fall through an exclusive comparison and never be followed up at all. Being generous at the
 * boundary costs nothing: the row this ends up writing is keyed `after:task:<id>` and that key is
 * UNIQUE, so a second look at the same task records nothing and raises nothing.
 */
export function tasksFinishedSince(conversationId, since) {
  return db.prepare(`SELECT * FROM tasks WHERE conversation_id = ? AND finished_at IS NOT NULL AND finished_at >= ?
    ORDER BY finished_at`).all(conversationId, since ?? 0).map(rowToTask);
}

/** Plans locked since the mark, on the same boundary rule and for the same reason. */
export function plansLockedSince(conversationId, since) {
  return db.prepare(`SELECT * FROM plans WHERE conversation_id = ? AND status = 'locked' AND updated_at >= ?
    ORDER BY updated_at`).all(conversationId, since ?? 0).map(rowToPlan);
}

// ---------- subscriptions ----------
//
// The truth of what somebody is paying for. "What am I paying for every month" is read from here,
// never from the model's memory of a scan it ran twenty messages ago.

/** One subscription per merchant, however the merchant was spelled. */
export function merchantKey(merchant) {
  return String(merchant ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

const SUB_STATUSES = ["active", "cancelling", "cancelled", "kept", "unknown"];
export { SUB_STATUSES as SUBSCRIPTION_STATUSES };

/**
 * Create or update one subscription, by merchant.
 *
 * Only the fields passed are changed, so a later call that knows the next renewal date does not
 * wipe the amount a scan found. `undefined` means "leave it"; an empty string means "set it empty",
 * which is the difference between not knowing and knowing there is nothing.
 */
export function recordSubscription(conversationId, { merchant, service, amountCents, currency, cadence, lastCharged, nextRenewal, source, status, cancelRoute, cancelUrl, cancelEmail, confirmation, notes }) {
  const key = merchantKey(merchant);
  if (!key) return { ok: false, error: "A subscription needs a merchant name." };
  if (status !== undefined && !SUB_STATUSES.includes(status)) {
    return { ok: false, error: `'${status}' is not a status. One of: ${SUB_STATUSES.join(", ")}.` };
  }
  const now = clock.now();
  const existing = getSubscription(conversationId, merchant);
  if (!existing) {
    db.prepare(`INSERT INTO subscriptions
      (conversation_id, merchant, merchant_key, service, amount_cents, currency, cadence, last_charged,
       next_renewal, source, status, cancel_route, cancel_url, cancel_email, confirmation, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(conversationId, String(merchant).trim(), key, service ?? "", amountCents ?? null, currency ?? "USD",
        cadence ?? "unknown", lastCharged ?? "", nextRenewal ?? "", source ?? "", status ?? "active",
        cancelRoute ?? "unknown", cancelUrl ?? "", cancelEmail ?? "", confirmation ?? "", notes ?? "", now, now);
    return { ok: true, created: true, subscription: getSubscription(conversationId, merchant) };
  }
  const sets = [];
  const args = [];
  const put = (col, value) => { if (value !== undefined) { sets.push(`${col} = ?`); args.push(value); } };
  put("merchant", merchant === undefined ? undefined : String(merchant).trim());
  put("service", service);
  put("amount_cents", amountCents);
  put("currency", currency);
  put("cadence", cadence);
  put("last_charged", lastCharged);
  put("next_renewal", nextRenewal);
  put("source", source);
  put("status", status);
  put("cancel_route", cancelRoute);
  put("cancel_url", cancelUrl);
  put("cancel_email", cancelEmail);
  put("confirmation", confirmation);
  put("notes", notes);
  // The moment it really ended, kept separately from `updated_at` so "when did you cancel this"
  // survives any later edit to the row.
  if (status === "cancelled" && !existing.cancelled_at) { sets.push("cancelled_at = ?"); args.push(now); }
  if (status !== undefined && status !== "cancelled") { sets.push("cancelled_at = NULL"); }
  if (!sets.length) return { ok: true, created: false, unchanged: true, subscription: existing };
  sets.push("updated_at = ?");
  args.push(now, existing.id);
  db.prepare(`UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return { ok: true, created: false, subscription: getSubscription(conversationId, merchant) };
}

export function getSubscription(conversationId, merchant) {
  return db.prepare("SELECT * FROM subscriptions WHERE conversation_id = ? AND merchant_key = ?")
    .get(conversationId, merchantKey(merchant)) ?? null;
}

export function getSubscriptionById(conversationId, id) {
  return db.prepare("SELECT * FROM subscriptions WHERE conversation_id = ? AND id = ?").get(conversationId, id) ?? null;
}

/**
 * Everything known, newest change first. `includeClosed` brings back the ones already cancelled or
 * deliberately kept — off by default, because "what am I paying for" is a question about what is
 * still going out.
 */
export function listSubscriptions(conversationId, { includeClosed = false } = {}) {
  const sql = includeClosed
    ? "SELECT * FROM subscriptions WHERE conversation_id = ? ORDER BY status, amount_cents DESC NULLS LAST, merchant"
    : `SELECT * FROM subscriptions WHERE conversation_id = ? AND status IN ('active', 'cancelling', 'unknown')
       ORDER BY amount_cents DESC NULLS LAST, merchant`;
  return db.prepare(sql).all(conversationId);
}

/** The ones mid-cancel, for the pass that looks for a confirmation email. */
export function cancellingSubscriptions(conversationId) {
  return db.prepare("SELECT * FROM subscriptions WHERE conversation_id = ? AND status = 'cancelling' ORDER BY updated_at")
    .all(conversationId);
}

export function deleteSubscription(conversationId, merchant) {
  const r = db.prepare("DELETE FROM subscriptions WHERE conversation_id = ? AND merchant_key = ?")
    .run(conversationId, merchantKey(merchant));
  return Number(r.changes) > 0;
}

export function setRenewalAt(conversationId, subscriptionId, renewalAtMs) {
  db.prepare("UPDATE subscriptions SET next_renewal_at = ?, updated_at = ? WHERE id = ? AND conversation_id = ?")
    .run(renewalAtMs, clock.now(), subscriptionId, conversationId);
}

export function renewingSoon(conversationId, beforeMs) {
  return db.prepare(
    `SELECT * FROM subscriptions WHERE conversation_id = ? AND status = 'active'
     AND next_renewal_at IS NOT NULL AND next_renewal_at > 0 AND next_renewal_at <= ?
     ORDER BY next_renewal_at`
  ).all(conversationId, beforeMs);
}

export function subscriptionSweepState(conversationId) {
  const row = db.prepare("SELECT last_subscription_check_at, last_subscription_scan_at FROM notice_sweeps WHERE conversation_id = ?")
    .get(conversationId);
  return { lastCheckAt: row?.last_subscription_check_at ?? null, lastScanAt: row?.last_subscription_scan_at ?? null };
}

export function markSubscriptionChecked(conversationId, at = clock.now()) {
  db.prepare(
    `INSERT INTO notice_sweeps (conversation_id, last_subscription_check_at) VALUES (?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET last_subscription_check_at = ?`
  ).run(conversationId, at, at);
}

export function markSubscriptionScanned(conversationId, at = clock.now()) {
  db.prepare(
    `INSERT INTO notice_sweeps (conversation_id, last_subscription_scan_at) VALUES (?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET last_subscription_scan_at = ?`
  ).run(conversationId, at, at);
}

// ---------- flights ----------
//
// What somebody is actually flying on, so "check-in just opened" is read off a row rather than off
// the model's memory of a conversation twenty messages ago. The reasoning for the three time columns
// is on the table itself.

const FLIGHT_STATUSES = ["booked", "offered", "checking_in", "checked_in", "needs_them", "missed", "cancelled"];
export { FLIGHT_STATUSES };

/**
 * One row per flight, however it was spelled.
 *
 * The key is the airline plus whichever identifier there is plus the date — a flight number when
 * there is one, otherwise the confirmation code. Two of those three come from the model reading
 * something, so the key is deliberately forgiving about case and spacing: "Delta DL1234" and
 * "delta dl 1234" on the same day are one flight and must not become two rows that then both nudge.
 */
export function flightKey({ airline, airlineKey, flightNumber, confirmationCode, departsLocal }) {
  const who = String(airlineKey || airline || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const what = String(flightNumber || confirmationCode || "").trim().toLowerCase().replace(/\s+/g, "");
  const day = String(departsLocal ?? "").slice(0, 10);
  return `${who}|${what}|${day}`;
}

/**
 * Create or update one flight.
 *
 * Only the fields passed are changed, so a later call that learns the seat does not wipe the
 * confirmation code. `undefined` means "leave it"; an empty string means "set it empty", which is
 * the difference between not knowing and knowing there is nothing.
 *
 * `departsAt` and `checkinOpensAt` are worked out by the caller (src/flights.js owns the clock) and
 * written here, so the scheduling instant and the words said out loud can never drift apart.
 */
export function recordFlight(conversationId, {
  airline, airlineKey, flightNumber, confirmationCode, passengerName,
  origin, originName, destination, destinationName,
  departsLocal, timeZone, departsAt, checkinOpensAt, checkinWindowHours,
  seatPreference, seat, boardingPosition, status, guessed, source, pageId, shotPath, notes,
} = {}) {
  if (status !== undefined && !FLIGHT_STATUSES.includes(status)) {
    return { ok: false, error: `'${status}' is not a flight status. One of: ${FLIGHT_STATUSES.join(", ")}.` };
  }
  const key = flightKey({ airline, airlineKey, flightNumber, confirmationCode, departsLocal });
  if (key === "||") return { ok: false, error: "A flight needs at least an airline and a departure date." };
  const now = clock.now();
  const existing = db.prepare("SELECT * FROM flights WHERE conversation_id = ? AND flight_key = ?").get(conversationId, key);
  if (!existing) {
    if (!Number.isFinite(Number(departsAt))) return { ok: false, error: "A new flight needs a real departure instant." };
    const r = db.prepare(`INSERT INTO flights
      (conversation_id, flight_key, airline, airline_key, flight_number, confirmation_code, passenger_name,
       origin, origin_name, destination, destination_name, departs_local, time_zone, departs_at,
       checkin_opens_at, checkin_window_hours, seat_preference, seat, boarding_position, status, guessed,
       source, page_id, shot_path, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(conversationId, key, String(airline ?? "").trim(), airlineKey ?? "", flightNumber ?? "", confirmationCode ?? "",
        passengerName ?? "", origin ?? "", originName ?? "", destination ?? "", destinationName ?? "",
        String(departsLocal ?? ""), String(timeZone ?? ""), Number(departsAt),
        checkinOpensAt ?? null, checkinWindowHours ?? null, seatPreference ?? "", seat ?? "", boardingPosition ?? "",
        status ?? "booked", JSON.stringify(guessed ?? []), source ?? "", pageId ?? "", shotPath ?? "", notes ?? "", now, now);
    return { ok: true, created: true, flight: getFlight(conversationId, Number(r.lastInsertRowid)) };
  }
  const sets = [];
  const args = [];
  const put = (col, value) => { if (value !== undefined) { sets.push(`${col} = ?`); args.push(value); } };
  put("airline", airline === undefined ? undefined : String(airline).trim());
  put("airline_key", airlineKey);
  put("flight_number", flightNumber);
  put("confirmation_code", confirmationCode);
  put("passenger_name", passengerName);
  put("origin", origin);
  put("origin_name", originName);
  put("destination", destination);
  put("destination_name", destinationName);
  put("departs_local", departsLocal);
  put("time_zone", timeZone);
  put("departs_at", departsAt);
  put("checkin_opens_at", checkinOpensAt);
  put("checkin_window_hours", checkinWindowHours);
  put("seat_preference", seatPreference);
  put("seat", seat);
  put("boarding_position", boardingPosition);
  put("status", status);
  put("guessed", guessed === undefined ? undefined : JSON.stringify(guessed));
  put("source", source);
  put("page_id", pageId);
  put("shot_path", shotPath);
  put("notes", notes);
  // The moment it really happened, kept separately from `updated_at` so "when did you check me in"
  // survives any later edit to the row.
  if (status === "checked_in" && !existing.checked_in_at) { sets.push("checked_in_at = ?"); args.push(now); }
  if (status !== undefined && status !== "checked_in") { sets.push("checked_in_at = NULL"); }
  if (!sets.length) return { ok: true, created: false, unchanged: true, flight: flightRow(existing) };
  sets.push("updated_at = ?");
  args.push(now, existing.id);
  db.prepare(`UPDATE flights SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return { ok: true, created: false, flight: getFlight(conversationId, existing.id) };
}

/** `guessed` comes out of SQLite as text; nothing above this line should have to know that. */
function flightRow(r) {
  if (!r) return null;
  let guessed = [];
  try { guessed = JSON.parse(r.guessed || "[]"); } catch { guessed = []; }
  return { ...r, guessed: Array.isArray(guessed) ? guessed : [] };
}

export function getFlight(conversationId, id) {
  return flightRow(db.prepare("SELECT * FROM flights WHERE conversation_id = ? AND id = ?").get(conversationId, id));
}

/** Newest departure last, which is the order somebody thinks about their own flights in. */
export function listFlights(conversationId, { includeClosed = false, now = null } = {}) {
  const rows = includeClosed
    ? db.prepare("SELECT * FROM flights WHERE conversation_id = ? ORDER BY departs_at").all(conversationId)
    : db.prepare("SELECT * FROM flights WHERE conversation_id = ? AND departs_at >= ? AND status != 'cancelled' ORDER BY departs_at")
      .all(conversationId, now ?? clock.now());
  return rows.map(flightRow);
}

/**
 * Every flight whose check-in window is open and whose check-in has not happened — across all
 * conversations, for the sweep to filter by person.
 *
 * `checkin_opens_at IS NOT NULL` rather than recomputing the window per row: it was worked out once
 * when the flight was saved, which is what makes this pass cheap enough to run on every sweep.
 */
export function flightsDueForCheckIn(now = clock.now()) {
  return db.prepare(`SELECT * FROM flights
     WHERE status IN ('booked', 'offered', 'checking_in', 'needs_them')
       AND checkin_opens_at IS NOT NULL AND checkin_opens_at <= ? AND departs_at > ?
     ORDER BY departs_at`).all(now, now).map(flightRow);
}

export function deleteFlight(conversationId, id) {
  const r = db.prepare("DELETE FROM flights WHERE conversation_id = ? AND id = ?").run(conversationId, id);
  return Number(r.changes) > 0;
}

// ---------- flight searches (Fli; src/flightsearch.js) ----------
//
// Added 2026-10-24. One row per search that reached Google (or tried to), keyed by conversation
// like everything else of theirs. It is what makes "no layovers" a change to the LAST search rather
// than a new one with half the constraints forgotten, and what `flight_verify` re-runs before a
// fare is recommended. `options` is the short list that was shown, so "the second one" means the
// same flight on the recheck that it meant when it was said.
db.exec(`
  CREATE TABLE IF NOT EXISTS flight_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,                        -- 'flights' | 'dates'
    params TEXT NOT NULL,                      -- the constraints as the sidecar was asked, JSON
    outcome TEXT NOT NULL,                     -- 'ok' | 'empty' | a FliError kind (src/fli.js)
    found INTEGER NOT NULL DEFAULT 0,
    from_cents INTEGER,                        -- lowest price in what came back, in the currency below
    currency TEXT NOT NULL DEFAULT 'USD',
    options TEXT NOT NULL DEFAULT '[]',        -- the short list shown, JSON
    ms INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS flight_searches_conv ON flight_searches (conversation_id, created_at);
`);

const flightSearchRow = (r) => r && {
  ...r,
  params: JSON.parse(r.params || "{}"),
  options: JSON.parse(r.options || "[]"),
};

export function recordFlightSearch(conversationId, { kind, params, outcome, found = 0, fromCents = null, currency = "USD", options = [], ms = null }) {
  const r = db.prepare(`INSERT INTO flight_searches (conversation_id, kind, params, outcome, found, from_cents, currency, options, ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, kind, JSON.stringify(params ?? {}), outcome, found, fromCents, currency || "USD", JSON.stringify(options ?? []), ms, clock.now());
  return Number(r.lastInsertRowid);
}
export function getFlightSearch(conversationId, id) {
  return flightSearchRow(db.prepare("SELECT * FROM flight_searches WHERE conversation_id = ? AND id = ?").get(conversationId, id)) ?? null;
}
export function lastFlightSearch(conversationId, kind = "flights") {
  return flightSearchRow(db.prepare("SELECT * FROM flight_searches WHERE conversation_id = ? AND kind = ? ORDER BY id DESC LIMIT 1").get(conversationId, kind)) ?? null;
}

/** When this conversation was last told flight prices weren't available (outcome 'unavailable'), or null. */
export function lastFlightsUnavailableAt(conversationId) {
  return db.prepare("SELECT MAX(created_at) AS at FROM flight_searches WHERE conversation_id = ? AND outcome = 'unavailable'").get(conversationId)?.at ?? null;
}

// ---------- flight source searches per month (src/flightproviders.js) ----------
//
// Added 2026-11-06. One row per provider per calendar month (UTC), counted BEFORE each search is
// sent, so SerpApi's free 250 a month is never crossed and nothing is billed. Not anybody's data.
db.exec(`
  CREATE TABLE IF NOT EXISTS flight_provider_usage (
    provider TEXT NOT NULL,                    -- 'serpapi' | 'duffel'
    month TEXT NOT NULL,                       -- 'YYYY-MM', UTC
    searches INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, month)
  );
`);

/** Take one search from this month's allowance. False — and nothing counted — once `limit` is reached. */
export function reserveFlightProviderSearch(provider, month, limit) {
  if (!(limit > 0)) return false;
  db.prepare("INSERT OR IGNORE INTO flight_provider_usage (provider, month, searches) VALUES (?, ?, 0)").run(provider, month);
  const r = db.prepare("UPDATE flight_provider_usage SET searches = searches + 1 WHERE provider = ? AND month = ? AND searches < ?").run(provider, month, limit);
  return r.changes === 1;
}
export function flightProviderSearches(provider, month) {
  return db.prepare("SELECT searches FROM flight_provider_usage WHERE provider = ? AND month = ?").get(provider, month)?.searches ?? 0;
}

// ---------- the people Reason writes to but does not send to ----------
//
// Added 2026-10-06. One row per person, with however many ways of reaching them have been saved as
// a JSON array — somebody's mother has a phone number and may also have an email, and both have to
// point at the same entry or the list protects half of her.
//
// `contacts` is where the enforcement actually lives: a name on its own is not something code can
// match a recipient against, so an entry with an empty array is a note and not a guard. That is said
// out loud per entry by the tool rather than hidden (see `important_list` in src/tools.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS important_people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    who TEXT NOT NULL,
    who_key TEXT NOT NULL,
    why TEXT NOT NULL DEFAULT '',
    contacts TEXT NOT NULL DEFAULT '[]',
    added_at INTEGER NOT NULL,
    UNIQUE(conversation_id, who_key)
  );
`);

const importantRow = (r) => (r ? { ...r, contacts: JSON.parse(r.contacts || "[]") } : null);

/**
 * Put somebody on the list, or add another way of reaching somebody already on it.
 *
 * Adding rather than replacing, for both halves: a second call that names a number does not wipe the
 * email, and one that names no contact at all does not wipe the ones already there. The only thing
 * that overwrites is `why`, and only when a new one is given.
 */
export function addImportantPerson(conversationId, { who, why = "", contact = "" }) {
  const key = String(who ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const existing = importantRow(db.prepare("SELECT * FROM important_people WHERE conversation_id = ? AND who_key = ?").get(conversationId, key));
  const add = String(contact ?? "").trim();
  const contacts = existing ? [...existing.contacts] : [];
  if (add && !contacts.some(c => c.toLowerCase() === add.toLowerCase())) contacts.push(add);
  if (existing) {
    db.prepare("UPDATE important_people SET who = ?, why = ?, contacts = ? WHERE id = ?")
      .run(String(who).trim(), why ? String(why).trim() : existing.why, seal2(conversationId, JSON.stringify(contacts)), existing.id);
    return { ...getImportantPerson(conversationId, key), already_there: true };
  }
  db.prepare("INSERT INTO important_people (conversation_id, who, who_key, why, contacts, added_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(conversationId, String(who).trim(), key, String(why ?? "").trim(), seal2(conversationId, JSON.stringify(contacts)), clock.now());
  return { ...getImportantPerson(conversationId, key), already_there: false };
}

export function getImportantPerson(conversationId, whoKey) {
  return importantRow(db.prepare("SELECT * FROM important_people WHERE conversation_id = ? AND who_key = ?").get(conversationId, whoKey));
}

export function listImportantPeople(conversationId) {
  return db.prepare("SELECT * FROM important_people WHERE conversation_id = ? ORDER BY added_at").all(conversationId).map(importantRow);
}

export function removeImportantPerson(conversationId, who) {
  const key = String(who ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const row = getImportantPerson(conversationId, key);
  if (!row) return { ok: false, error: `'${who}' is not on the list.` };
  db.prepare("DELETE FROM important_people WHERE id = ?").run(row.id);
  return { ok: true, removed: row };
}

// ---------- taste: what they turned down, and why ----------
//
// Added 2026-10-06. A rejection is the cheapest preference there is and the one most often thrown
// away. "Too expensive for a tuesday" about one restaurant is a fact about every restaurant after
// it, and on the task sheet it was per-task: the apartment hunt knew the two places turned down and
// the dinner three weeks later knew nothing. So a rejection becomes a row here, once, and it is read
// back on every later pick.
//
// Three columns carry the honesty of it:
//
//   `category`  one of src/sheet.js's READINGS — price, vibe, timing, location, other. The MODEL's
//               one-word reading, so "too dear", "bit much" and "over budget" are comparable later.
//               A fixed list rather than free text, because a taste nobody can group is a note.
//   `words`     their own sentence, verbatim. The row's whole claim to being theirs rather than
//               Reason's theory, and what a correction replaces.
//   `note`      one line on what it means for next time, written by the model. Empty is allowed: a
//               rejection learned off a sheet has their words and a category and nothing else, and
//               inventing a sentence there would be Reason putting words in their mouth.
//
// A preference is NOT a permission, and that is not enforced here because there is nothing to
// enforce: the gate (src/permissions.js, consulted in src/tools.js) reads the `permissions` table and
// has never read this one. `test/taste.test.js` pins it, because the day somebody wires a preference
// into a gate is the day it stops being true.
//
// Deleting one is a real DELETE rather than a flag, for the same reason a forgotten fact is: the row
// holds their own sentence, and a "forget that" that left it on disk would not be a forget. Not swept
// by the retention pass — it is something they said about themselves rather than a copy of something
// that arrived — so it goes when they delete their data, which src/data.js covers.
db.exec(`
  CREATE TABLE IF NOT EXISTS preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    category TEXT NOT NULL,
    words TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    turned_down TEXT NOT NULL DEFAULT '',
    task_id INTEGER,
    learned_at INTEGER NOT NULL,
    corrected_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS preferences_by_conversation ON preferences (conversation_id, learned_at);
`);

/**
 * Write one down. Returns the row, with `already_knew` when it was there: the same words about the
 * same thing twice is one preference, because a model re-reading a rejection on a later wake should
 * not make the list noisier.
 */
export function learnPreference(conversationId, { category, words, note = "", turnedDown = "", taskId = null } = {}) {
  const clean = String(words ?? "").trim();
  const cat = String(category ?? "").trim();
  if (!clean || !cat) return null;
  const down = String(turnedDown ?? "").trim();
  const before = db.prepare("SELECT * FROM preferences WHERE conversation_id = ? AND pt(words) = ? AND pt(turned_down) = ?")
    .get(conversationId, clean, down);
  if (before) return { ...before, already_knew: true };
  const r = db.prepare(`INSERT INTO preferences (conversation_id, category, words, note, turned_down, task_id, learned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, cat, seal2(conversationId, clean), seal2(conversationId, String(note ?? "").trim()), seal2(conversationId, down), taskId, clock.now());
  return { ...getPreference(conversationId, Number(r.lastInsertRowid)), already_knew: false };
}

export function getPreference(conversationId, id) {
  return db.prepare("SELECT * FROM preferences WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
}

/**
 * A setting kept as a preference row that can only have ONE value: meal logging on or off, calorie
 * numbers shown or not. Every earlier row of that category is replaced, not added to.
 *
 * Until 2026-10-19 these went through `learnPreference`, which appends, and were read with
 * `prefs.some(p => p.category === "meal_logging" && !p.turned_down)` — so once somebody had said
 * yes, a later "no, stop logging my meals" added a second row and the yes still won. And because
 * `learnPreference` treats the same words twice as one row, saying yes again after a no handed back
 * the OLD yes with its old date, so "newest wins" could not have fixed it on the read side alone.
 * One row per setting is what makes the latest answer the answer.
 */
export function setOnlyPreference(conversationId, { category, words, note = "", turnedDown = "" } = {}) {
  const cat = String(category ?? "").trim();
  const clean = String(words ?? "").trim();
  if (!cat || !clean) return null;
  let id;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM preferences WHERE conversation_id = ? AND category = ?").run(conversationId, cat);
    id = Number(db.prepare(`INSERT INTO preferences (conversation_id, category, words, note, turned_down, task_id, learned_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)`)
      .run(conversationId, cat, seal2(conversationId, clean), seal2(conversationId, String(note ?? "").trim()),
        seal2(conversationId, String(turnedDown ?? "").trim()), clock.now()).lastInsertRowid);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getPreference(conversationId, id);
}

/**
 * The newest row of one category, or null. Not through `listPreferences`: that is capped at 30 for
 * showing tastes, and a "stop showing calorie numbers" said 31 preferences ago is still in force.
 */
export function latestPreference(conversationId, category) {
  return db.prepare("SELECT * FROM preferences WHERE conversation_id = ? AND category = ? ORDER BY learned_at DESC, id DESC LIMIT 1")
    .get(conversationId, category) ?? null;
}

/** Newest first. The list every later option pick is told about. */
export function listPreferences(conversationId, { limit = 30 } = {}) {
  return db.prepare("SELECT * FROM preferences WHERE conversation_id = ? ORDER BY learned_at DESC, id DESC LIMIT ?")
    .all(conversationId, limit);
}

/**
 * Change one row and nothing else, from something they said.
 *
 * The row as it WAS comes back, so the caller can take the old reading out of everywhere else it was
 * used — the saved thread above all, where a wrong reading would otherwise be read back on the very
 * next turn (see `scrubToolResults` and `redactFromReplies`). A correction that only fixed the row
 * would leave Reason repeating the thing it had just been corrected on.
 */
export function correctPreference(conversationId, id, { category = null, words = null, note = null } = {}) {
  const row = getPreference(conversationId, id);
  if (!row) return { ok: false, error: `There is no preference #${id} here.` };
  const sets = ["corrected_at = ?"];
  const args = [clock.now()];
  for (const [col, v] of [["category", category], ["words", words], ["note", note]]) {
    if (v === null || v === undefined) continue;
    const clean = String(v).trim();
    if (!clean) continue;
    sets.push(`${col} = ?`);
    args.push(restcrypt.sealCell("preferences", col, conversationId, clean));
  }
  db.prepare(`UPDATE preferences SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  return { ok: true, was: row, preference: getPreference(conversationId, id) };
}

/** Gone, really. The row holds their own sentence, so a drop that kept it would not be a drop. */
export function dropPreference(conversationId, id) {
  const row = getPreference(conversationId, id);
  if (!row) return { ok: false, error: `There is no preference #${id} here.` };
  db.prepare("DELETE FROM preferences WHERE id = ?").run(id);
  return { ok: true, was: row };
}

// ---------- what Reason is guessing, kept as a guess ----------
//
// Added 2026-10-06. `remember` has always refused to save anything but what somebody said, and the
// failure it was written against is exact: Reason reads "they bought a car" off a picture, saves it,
// they say "that's my friend's car", and the correction fixes the conversation while the saved line
// goes on being true forever.
//
// Refusing was right and it was not enough. The reading still existed — in the thread, in whatever
// Reason said next — it just was not written anywhere a person could see it or correct it. So a
// refused fact now lands here instead of nowhere, in its own table, labelled as a guess, with HOW it
// was arrived at. It appears on the memory page under "things I'm guessing", and the page says out
// loud that a guess is never stated back as a fact.
//
// `confirmed_at` is the only way out. A guess becomes a fact when THEY say it — which means an
// ordinary `remember` with source `they_said`, the same bar as everything else — and at that moment
// the row here is marked and stops being a guess. Nothing else promotes one: not a second reading of
// the same picture, not the model being more sure the next time.
db.exec(`
  CREATE TABLE IF NOT EXISTS guesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    about TEXT NOT NULL,
    guess TEXT NOT NULL,
    how TEXT NOT NULL,
    noted_at INTEGER NOT NULL,
    corrected_at INTEGER,
    confirmed_at INTEGER,
    confirmed_said TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS guesses_by_conversation ON guesses (conversation_id, confirmed_at);
`);
addColumnIfMissing("guesses", "evidence", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("guesses", "use", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("guesses", "last_supported_at", "INTEGER");
// "No" to a guess on the memory page (Reason Web). The row stays, so `noteGuess` finds the same
// words again and hands back this one rather than suggesting it afresh; every list leaves it out.
addColumnIfMissing("guesses", "dismissed_at", "INTEGER");

/** Where a guess came from. Both are things `remember` refuses to save as facts. */
export const GUESS_SOURCES = ["i_worked_it_out", "i_saw_it_in_a_photo", "i_noticed_a_pattern", "i_noticed_it_across_days"];
export const PATTERN_SOURCE = "i_noticed_a_pattern";
/**
 * Something that recurred in what they SAID, on at least two different days (src/dream.js
 * noticePatterns): a repeated ask, a routine, a mistake Reason keeps making, a preference shown more
 * than once. A guess like the others — never a fact — with the messages it rests on as its evidence.
 * Not PATTERN_SOURCE: that one is a rhythm in message TIMES and moves when a nudge lands (src/notice.js).
 */
export const NOTICED_SOURCE = "i_noticed_it_across_days";

/** Note one, or hand back the one already there. The same guess twice is one guess. */
export function noteGuess(conversationId, { about, guess, how = "i_worked_it_out", evidence = null, use = "" } = {}) {
  const who = String(about ?? "").trim();
  const what = String(guess ?? "").trim();
  if (!who || !what) return null;
  const source = GUESS_SOURCES.includes(how) ? how : "i_worked_it_out";
  const before = db.prepare("SELECT * FROM guesses WHERE conversation_id = ? AND pt(about) = ? AND pt(guess) = ?")
    .get(conversationId, who, what);
  if (before) return { ...before, already_guessed: true };
  const receipts = JSON.stringify(Array.isArray(evidence) ? evidence : []);
  const changes = String(use ?? "").trim();
  const r = db.prepare(`INSERT INTO guesses (conversation_id, about, guess, how, noted_at, evidence, "use", last_supported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, seal2(conversationId, who), seal2(conversationId, what), source, clock.now(),
      seal2(conversationId, receipts), seal2(conversationId, changes),
      source === PATTERN_SOURCE || source === NOTICED_SOURCE ? clock.now() : null);
  return { ...getGuess(conversationId, Number(r.lastInsertRowid)), already_guessed: false };
}

export function getGuess(conversationId, id) {
  return db.prepare("SELECT * FROM guesses WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
}

/** The ones still guesses. A confirmed one is a fact now and belongs in the facts section. */
export function listGuesses(conversationId, { includeConfirmed = false, includePatterns = false, limit = 40 } = {}) {
  const where = ["conversation_id = ?", "dismissed_at IS NULL"];
  const args = [conversationId];
  if (!includeConfirmed) where.push("confirmed_at IS NULL");
  if (!includePatterns) { where.push("how != ?"); args.push(PATTERN_SOURCE); }
  const sql = `SELECT * FROM guesses WHERE ${where.join(" AND ")} ORDER BY noted_at DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit);
}

/**
 * They said it, so it is not a guess any more.
 *
 * Called from the `remember` path and nowhere else, which is the whole rule: the only thing that
 * promotes a guess is the person saying the thing, with their sentence kept. Matched on the subject
 * and the words, so saving a DIFFERENT fact about the same person leaves the guess exactly where it
 * was — being told "Kofi lives in Bed-Stuy" is not confirmation that he bought a car.
 */
export function confirmGuess(conversationId, { about, guess, said = "" } = {}) {
  const row = db.prepare(`SELECT * FROM guesses WHERE conversation_id = ? AND pt(about) = ? AND pt(guess) = ?
    AND confirmed_at IS NULL`).get(conversationId, String(about ?? "").trim(), String(guess ?? "").trim());
  if (!row) return null;
  db.prepare("UPDATE guesses SET confirmed_at = ?, confirmed_said = ? WHERE id = ?")
    .run(clock.now(), seal2(conversationId, String(said ?? "").trim()), row.id);
  return getGuess(conversationId, row.id);
}

/** Change the wording of one guess, from something they said. Returns the row as it was. */
export function correctGuess(conversationId, id, { guess = null, about = null } = {}) {
  const row = getGuess(conversationId, id);
  if (!row) return { ok: false, error: `There is no guess #${id} here.` };
  const sets = ["corrected_at = ?"];
  const args = [clock.now()];
  for (const [col, v] of [["guess", guess], ["about", about]]) {
    if (v === null || v === undefined) continue;
    const clean = String(v).trim();
    if (!clean) continue;
    sets.push(`${col} = ?`);
    args.push(restcrypt.sealCell("guesses", col, conversationId, clean));
  }
  db.prepare(`UPDATE guesses SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  return { ok: true, was: row, guess: getGuess(conversationId, id) };
}

/**
 * "No, that's not right", from the memory page: the guess stops being shown or used, and because the
 * row stays (marked), the same words noted again find it and are not suggested a second time.
 */
export function dismissGuess(conversationId, id) {
  const row = getGuess(conversationId, id);
  if (!row || row.dismissed_at || row.confirmed_at) return { ok: false, error: `There is no open guess #${id} here.` };
  db.prepare("UPDATE guesses SET dismissed_at = ? WHERE id = ?").run(clock.now(), id);
  return { ok: true, was: row };
}

/** Gone, really: a guess somebody has corrected should not sit on disk being wrong. */
export function dropGuess(conversationId, id) {
  const row = getGuess(conversationId, id);
  if (!row) return { ok: false, error: `There is no guess #${id} here.` };
  db.prepare("DELETE FROM guesses WHERE id = ?").run(id);
  return { ok: true, was: row };
}

// ---------- patterns: rhythms across weeks ----------

export function listPatterns(conversationId, { limit = 20 } = {}) {
  return db.prepare(`SELECT * FROM guesses WHERE conversation_id = ? AND how = ? AND confirmed_at IS NULL AND dismissed_at IS NULL
    ORDER BY noted_at DESC, id DESC LIMIT ?`).all(conversationId, PATTERN_SOURCE, limit)
    .map(r => ({ ...r, evidence: parseEvidence(r.evidence) }));
}

export function getPattern(conversationId, id) {
  const row = getGuess(conversationId, id);
  if (!row || row.how !== PATTERN_SOURCE) return null;
  return { ...row, evidence: parseEvidence(row.evidence) };
}

function parseEvidence(raw) {
  try {
    const got = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(got) ? got : [];
  } catch { return []; }
}

export function supportPattern(conversationId, id, at = clock.now(), { evidence = null } = {}) {
  const row = getPattern(conversationId, id);
  if (!row) return null;
  if (Array.isArray(evidence) && evidence.length) {
    db.prepare(`UPDATE guesses SET last_supported_at = ?, evidence = ? WHERE id = ?`)
      .run(at, seal2(conversationId, JSON.stringify(evidence)), id);
  } else {
    db.prepare("UPDATE guesses SET last_supported_at = ? WHERE id = ?").run(at, id);
  }
  return getPattern(conversationId, id);
}

export function patternsUnsupportedSince(conversationId, before) {
  return db.prepare(`SELECT * FROM guesses WHERE conversation_id = ? AND how = ? AND confirmed_at IS NULL AND dismissed_at IS NULL
      AND COALESCE(last_supported_at, noted_at) < ?`)
    .all(conversationId, PATTERN_SOURCE, before)
    .map(r => ({ ...r, evidence: parseEvidence(r.evidence) }));
}

export function dropPatterns(conversationId) {
  const rows = listPatterns(conversationId, { limit: 500 });
  // "Stop reading into my texts" means the things noticed across days too (src/dream.js), not only rhythms.
  db.prepare("DELETE FROM guesses WHERE conversation_id = ? AND how IN (?, ?)").run(conversationId, PATTERN_SOURCE, NOTICED_SOURCE);
  return rows;
}

/** What the review noticed across days and they have not confirmed or dismissed, newest first. */
export function listNoticed(conversationId, { limit = 20 } = {}) {
  return db.prepare(`SELECT * FROM guesses WHERE conversation_id = ? AND how = ? AND confirmed_at IS NULL AND dismissed_at IS NULL
    ORDER BY noted_at DESC, id DESC LIMIT ?`).all(conversationId, NOTICED_SOURCE, limit)
    .map(r => ({ ...r, evidence: parseEvidence(r.evidence) }));
}

/** A noticed thing was borne out again: fresh receipts, and the clock that expires it starts over. */
export function supportNoticed(conversationId, id, at = clock.now(), { evidence = null } = {}) {
  const row = getGuess(conversationId, id);
  if (!row || row.how !== NOTICED_SOURCE || row.confirmed_at || row.dismissed_at) return null;
  if (Array.isArray(evidence) && evidence.length) {
    db.prepare("UPDATE guesses SET last_supported_at = ?, evidence = ? WHERE id = ? AND conversation_id = ?").run(at, seal2(conversationId, JSON.stringify(evidence)), id, conversationId);
  } else {
    db.prepare("UPDATE guesses SET last_supported_at = ? WHERE id = ? AND conversation_id = ?").run(at, id, conversationId);
  }
  return getGuess(conversationId, id);
}

// ---------- pattern_asks: the example parked between the consent question and the answer ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS pattern_asks (
    conversation_id TEXT PRIMARY KEY,
    about TEXT NOT NULL,
    inference TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]',
    "use" TEXT NOT NULL DEFAULT '',
    asked_at INTEGER NOT NULL
  );
`);

export function holdPatternAsk(conversationId, { about, inference, evidence = [], use = "", at = clock.now() } = {}) {
  const have = patternAsk(conversationId);
  if (have) return { ...have, already_asked: true };
  db.prepare(`INSERT INTO pattern_asks (conversation_id, about, inference, evidence, "use", asked_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(conversationId, String(about).trim(), String(inference).trim(),
      JSON.stringify(Array.isArray(evidence) ? evidence : []), String(use ?? "").trim(), at);
  return { ...patternAsk(conversationId), already_asked: false };
}

export function patternAsk(conversationId) {
  const row = db.prepare("SELECT * FROM pattern_asks WHERE conversation_id = ?").get(conversationId);
  return row ? { ...row, evidence: parseEvidence(row.evidence) } : null;
}

export function takePatternAsk(conversationId) {
  const row = patternAsk(conversationId);
  if (!row) return null;
  db.prepare("DELETE FROM pattern_asks WHERE conversation_id = ?").run(conversationId);
  return row;
}

// ---------- inbound/outbound times for rhythms ----------

export function inboundTimes(conversationId, { since, until = clock.now(), limit = 2000 } = {}) {
  return db.prepare(`SELECT id, external_id AS handle, received_at AS at FROM inbound_messages
      WHERE conversation_id = ? AND received_at >= ? AND received_at <= ?
      ORDER BY received_at ASC, id ASC LIMIT ?`)
    .all(conversationId, since ?? 0, until, limit);
}

export function outboundTimes(conversationId, { since, until = clock.now(), limit = 2000 } = {}) {
  return db.prepare(`SELECT id, message_id AS handle, sent_at AS at FROM outbox
      WHERE conversation_id = ? AND state = 'sent' AND to_owner = 1 AND sent_at >= ? AND sent_at <= ?
      ORDER BY sent_at ASC, id ASC LIMIT ?`)
    .all(conversationId, since ?? 0, until, limit);
}

// ---------- why they are doing it: the reason, kept apart from the facts ----------
//
// Added 2026-10-06. "I want to move" is one job; "I want to move to save money" and "I want to move
// for a shorter commute" are two, and until this table existed Reason could not tell them apart an
// hour later. The reason was in the sentence, the sentence got trimmed out of the context, and the
// third apartment came back ranked the way the second one was.
//
// Why its own table rather than a fact or a constraint:
//
//   - A FACT is what stays true about somebody ("allergic to shellfish"). A reason is what they are
//     trying to achieve, which is a different thing and has a different life: it is answered, or it
//     changes, or it stops applying.
//   - A CONSTRAINT lives on one job's sheet and dies with it. A reason outlives the task it was said
//     on — the point of saving it is that the NEXT thing on the same subject is ranked by it too.
//   - A PREFERENCE is a reading of a no. A reason is a thing they stated out loud, in words, which is
//     why `said` is required and why nothing in here may be written from an inference.
//
// The columns:
//
//   `about`   the subject, as they talk about it: 'moving', 'the job hunt', 'the car'. Not a person.
//   `why`     the goal in their terms, short: 'to save money', 'a shorter commute'.
//   `said`    their sentence, verbatim. The row's whole claim to being theirs rather than Reason's
//             theory about them, and what a correction replaces. Required, always.
//   `task_id` the sheet it was said on, when there was one. Kept so "where did this come from" has
//             an answer; NOT what scopes it, because the carrying-forward is the point.
//
// A correction SUPERSEDES rather than overwrites: the old row is stamped `superseded_at` and points
// at the row that replaced it, exactly as a steer on a sheet is appended rather than edited. Somebody
// whose reason changed from saving money to a shorter commute should be able to see that it changed
// and when — and Reason having quietly rewritten history is how "you said this was about money" stops
// being checkable. A `forget` or a drop is still a real DELETE, because the row quotes them.
db.exec(`
  CREATE TABLE IF NOT EXISTS whys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    about TEXT NOT NULL,
    why TEXT NOT NULL,
    said TEXT NOT NULL,
    task_id INTEGER,
    stated_at INTEGER NOT NULL,
    superseded_at INTEGER,
    superseded_by INTEGER
  );
  CREATE INDEX IF NOT EXISTS whys_by_conversation ON whys (conversation_id, superseded_at);
`);

/**
 * Write down why they are doing something. Returns the row, with `already_knew` when the same reason
 * is already standing for the same subject — a model re-reading its own sheet on a later wake should
 * not make the list longer.
 *
 * `said` is refused when empty, here as well as in the tool: a reason with no sentence behind it is
 * Reason deciding what somebody wants, which is the one thing this table exists to prevent.
 */
export function stateWhy(conversationId, { about, why, said, taskId = null } = {}) {
  const subject = String(about ?? "").trim();
  const goal = String(why ?? "").trim();
  const words = String(said ?? "").trim();
  if (!subject || !goal || !words) return null;
  const before = db.prepare(`SELECT * FROM whys WHERE conversation_id = ? AND pt(about) = ? AND pt(why) = ?
    AND superseded_at IS NULL`).get(conversationId, subject, goal);
  if (before) return { ...before, already_knew: true };
  const r = db.prepare(`INSERT INTO whys (conversation_id, about, why, said, task_id, stated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(conversationId, seal2(conversationId, subject), seal2(conversationId, goal), seal2(conversationId, words), taskId, clock.now());
  return { ...getWhy(conversationId, Number(r.lastInsertRowid)), already_knew: false };
}

export function getWhy(conversationId, id) {
  return db.prepare("SELECT * FROM whys WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
}

/** The reasons still standing, newest first. `includeSuperseded` is for the audit trail. */
export function listWhys(conversationId, { includeSuperseded = false, limit = 20 } = {}) {
  const sql = includeSuperseded
    ? "SELECT * FROM whys WHERE conversation_id = ? ORDER BY stated_at DESC, id DESC LIMIT ?"
    : "SELECT * FROM whys WHERE conversation_id = ? AND superseded_at IS NULL ORDER BY stated_at DESC, id DESC LIMIT ?";
  return db.prepare(sql).all(conversationId, limit);
}

/**
 * They have put the reason right. The old row is superseded and a new one takes its place.
 *
 * Returns the row as it WAS, like every other correction here, so the caller can take the old wording
 * out of everywhere it was carried forward — the saved thread above all, where the next turn would
 * otherwise read "this is about saving money" straight back and rank on it again.
 */
export function correctWhy(conversationId, id, { why = null, said }) {
  const row = getWhy(conversationId, id);
  if (!row) return { ok: false, error: `There is no reason #${id} here.` };
  if (row.superseded_at) {
    return { ok: false, error: `Reason #${id} was already replaced by #${row.superseded_by}. Correct that one instead.` };
  }
  const goal = String(why ?? "").trim();
  const words = String(said ?? "").trim();
  if (!goal) return { ok: false, error: `A reason is corrected by its new wording: say what they are actually after.` };
  if (!words) return { ok: false, error: `A correction needs their own words, verbatim.` };
  const now = clock.now();
  const r = db.prepare(`INSERT INTO whys (conversation_id, about, why, said, task_id, stated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(conversationId, seal2(conversationId, row.about), seal2(conversationId, goal), seal2(conversationId, words), row.task_id, now);
  const next = Number(r.lastInsertRowid);
  db.prepare("UPDATE whys SET superseded_at = ?, superseded_by = ? WHERE id = ?").run(now, next, id);
  return { ok: true, was: row, why: getWhy(conversationId, next) };
}

/** Gone, really. The row quotes them, so a "forget that" that left it on disk would not be one. */
export function dropWhy(conversationId, id) {
  const row = getWhy(conversationId, id);
  if (!row) return { ok: false, error: `There is no reason #${id} here.` };
  db.prepare("DELETE FROM whys WHERE id = ?").run(id);
  // Anything this one replaced stays replaced. Reviving the row before it would mean "forget that"
  // handed somebody back a reason they had already corrected, which is the opposite of forgetting.
  return { ok: true, was: row };
}

// ---------- one saved fact, by its id ----------
//
// `recall` answers by subject, which is what a conversation needs. A memory page needs the other
// handle: every row has a number, and a correction changes exactly the row with that number. Facts
// hang off `people`, so every one of these joins through it — which is also what scopes them to one
// person's Reason.

export function getFact(conversationId, id) {
  return db.prepare(`SELECT f.id, f.fact, f.created_at, f.confidence, f.source, f.category, f.memory_group, f.source_message_ids,
    p.name AS about, p.id AS person_id
    FROM person_facts f JOIN people p ON p.id = f.person_id
    WHERE f.id = ? AND p.conversation_id = ? AND f.status = 'active'`).get(id, conversationId) ?? null;
}

/** Every fact on record with its id and its subject, newest subject first. The page's first section. */
export function listFacts(conversationId, { limit = 60 } = {}) {
  return db.prepare(`SELECT f.id, f.fact, f.created_at, f.confidence, f.source, p.name AS about
    FROM person_facts f JOIN people p ON p.id = f.person_id
    WHERE p.conversation_id = ? AND f.status = 'active'
    ORDER BY p.updated_at DESC, p.id, f.created_at, f.id LIMIT ?`).all(conversationId, limit);
}

/**
 * Replace the wording of one fact, from something they said.
 *
 * The row as it WAS comes back, because fixing the row is only half of a correction: the old reading
 * is also sitting in the saved thread, in a `recall` result and in whatever Reason said off the back
 * of it, and the next turn reads those. See `scrubToolResults` and `redactFromReplies`, which the
 * caller runs with the old words.
 *
 * Refuses a wording already on the same subject, so a correction cannot quietly collapse two facts
 * into one and lose the other.
 */
export function correctFact(conversationId, id, { fact }) {
  const row = getFact(conversationId, id);
  if (!row) return { ok: false, error: `There is no saved fact #${id} here.` };
  const clean = String(fact ?? "").trim();
  if (!clean) return { ok: false, error: `A correction needs the new wording in 'instead'.` };
  if (clean === row.fact) return { ok: true, unchanged: true, was: row, fact: row };
  // The same fact across case and a trailing full stop is the same fact (`factKey`), as `remember` reads it.
  const clash = db.prepare("SELECT id, fact FROM person_facts WHERE person_id = ? AND id != ? AND status = 'active'")
    .all(row.person_id, id).find(r => factKey(r.fact) === factKey(clean));
  if (clash) {
    return {
      ok: false,
      error: `'${clean}' is already saved about ${row.about} as #${clash.id}. Correcting this one into it would leave two`
        + ` rows saying the same thing and then quietly lose one. Drop #${id} instead if it is simply wrong.`,
    };
  }
  const now = clock.now();
  const r = db.prepare(
    `INSERT INTO person_facts (person_id, fact, created_at, valid_from, status, confidence, source, source_message_ids, category, memory_group)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
  ).run(row.person_id, sealFact(row.person_id, clean), now, now,
    row.confidence ?? 1.0, row.source ?? "user_stated",
    row.source_message_ids ?? "[]", row.category ?? "", row.memory_group ?? "");
  const newId = Number(r.lastInsertRowid);
  db.prepare("UPDATE person_facts SET status = 'corrected', valid_to = ?, superseded_by = ? WHERE id = ?")
    .run(now, newId, id);
  db.prepare("UPDATE people SET updated_at = ? WHERE id = ?").run(now, row.person_id);
  outOfProfile(conversationId, id);
  return { ok: true, was: row, newId, fact: getFact(conversationId, newId) };
}

/** One fact gone. The subject stays: forgetting one thing about somebody is not forgetting them. */
export function dropFact(conversationId, id) {
  const row = getFact(conversationId, id);
  if (!row) return { ok: false, error: `There is no saved fact #${id} here.` };
  db.prepare("UPDATE person_facts SET status = 'deleted', valid_to = ? WHERE id = ?").run(clock.now(), id);
  outOfProfile(conversationId, id);
  return { ok: true, was: row };
}

/**
 * The profile (src/extract.js `rebuildProfile`) is a saved block of text that rides on every turn
 * (src/memorynote.js) and is rebuilt on the background lane, which may be minutes away. A fact taken
 * back that was in it would ride along until then, so the block goes now when it carried that fact;
 * the caller schedules the rebuild.
 */
function outOfProfile(conversationId, factId) {
  const p = getProfile(conversationId);
  if (!p) return;
  let ids = [];
  try { ids = JSON.parse(p.fact_ids || "[]"); } catch { ids = []; }
  if (ids.includes(Number(factId))) invalidateProfile(conversationId);
}

// ---------- the memory page's groups (Reason Web, handoff §5) ----------
//
// The page files every fact under one of five headings. Which one is a reading of what the fact
// means, so a model chooses it — the extractor as it writes (src/extract.js `group`), or the
// background filer for every row written without one (src/factgroups.js). Kept on the row so the
// page is one read and the same fact never moves between visits.

/** Every active fact of one conversation, with its subject and group, newest first. No cap: the page lists them all. */
export function memoryFacts(conversationId) {
  return db.prepare(`SELECT f.id, f.fact, f.created_at, f.source, f.category, f.memory_group, p.name AS about, p.key AS about_key
    FROM person_facts f JOIN people p ON p.id = f.person_id
    WHERE p.conversation_id = ? AND f.status = 'active'
    ORDER BY f.created_at DESC, f.id DESC`).all(conversationId);
}

/** Active facts with no group yet, all from one conversation (the one with the oldest), oldest first. */
export function unfiledFacts({ limit = 60, skip = [] } = {}) {
  // `skip`: ids the filer has given up on, so one stubborn row never holds up every other conversation.
  const ids = [...skip].map(Number).filter(Number.isInteger);
  const not = ids.length ? ` AND f.id NOT IN (${ids.map(() => "?").join(",")})` : "";
  const first = db.prepare(`SELECT p.conversation_id FROM person_facts f JOIN people p ON p.id = f.person_id
    WHERE f.status = 'active' AND f.memory_group = ''${not} ORDER BY f.id LIMIT 1`).get(...ids);
  if (!first) return [];
  return db.prepare(`SELECT f.id, f.fact, f.category, p.name AS about, p.key AS about_key, p.conversation_id
    FROM person_facts f JOIN people p ON p.id = f.person_id
    WHERE p.conversation_id = ? AND f.status = 'active' AND f.memory_group = ''${not} ORDER BY f.id LIMIT ?`).all(first.conversation_id, ...ids, limit);
}

/** How many active facts still have no group, across every conversation. */
export function unfiledCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM person_facts WHERE status = 'active' AND memory_group = ''").get().n;
}

/** File one fact under one of the five groups. Anything else is refused. */
export function fileFact(id, group) {
  if (!MEMORY_GROUPS.includes(group)) return false;
  return db.prepare("UPDATE person_facts SET memory_group = ? WHERE id = ?").run(group, id).changes > 0;
}

// ---------- the hard line, counted ----------
//
// One row per message the harm screen refused (src/harm.js), plus the crisis reads and the replies
// held back on the way out. When, which kind, and the screen's one phrase. Never the message: the
// thread already has that, and this table exists to answer "how many times, and what kind" for the
// strike count and the master's heads-up — not to let anybody reread it.
db.exec(`
  CREATE TABLE IF NOT EXISTS harm_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS harm_events_by_conversation ON harm_events (conversation_id, at);
`);

export function recordHarmEvent({ conversationId, at = clock.now(), verdict, category = "", note = "" }) {
  const r = db.prepare("INSERT INTO harm_events (conversation_id, at, verdict, category, note) VALUES (?, ?, ?, ?, ?)")
    .run(conversationId, at, String(verdict), String(category ?? ""), String(note ?? "").slice(0, 160));
  return Number(r.lastInsertRowid);
}

/** The events since a moment, oldest first. `verdict` narrows to one kind (the strike count wants 'harm'). */
export function harmEventsSince(conversationId, sinceMs, { verdict = null } = {}) {
  return verdict
    ? db.prepare("SELECT * FROM harm_events WHERE conversation_id = ? AND at >= ? AND verdict = ? ORDER BY at").all(conversationId, sinceMs, verdict)
    : db.prepare("SELECT * FROM harm_events WHERE conversation_id = ? AND at >= ? ORDER BY at").all(conversationId, sinceMs);
}

/**
 * A strike that was the screen's mistake, voided. The row stays (when, which kind, what the screen
 * said) with its verdict set to 'void' and the reason in front of the note, so it no longer counts
 * toward a pause or the ops tally, and "what happened" still has an answer. Only a 'harm' row of
 * that conversation can be voided; anything else is left alone. Returns whether it changed.
 */
export function voidHarmEvent({ conversationId, id, why = "" }) {
  const r = db.prepare("UPDATE harm_events SET verdict = 'void', note = substr(?, 1, 160) WHERE id = ? AND conversation_id = ? AND verdict = 'harm'")
    .run(`void: ${String(why || "false positive")} | was: ` + (db.prepare("SELECT note FROM harm_events WHERE id = ?").get(id)?.note ?? ""), Number(id), String(conversationId));
  return r.changes > 0;
}

// ---------- meal estimates ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS meal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    media_id INTEGER,
    type TEXT NOT NULL,
    items TEXT NOT NULL DEFAULT '[]',
    kcal_low INTEGER NOT NULL DEFAULT 0,
    kcal_likely INTEGER NOT NULL DEFAULT 0,
    kcal_high INTEGER NOT NULL DEFAULT 0,
    protein_g INTEGER NOT NULL DEFAULT 0,
    carbs_g INTEGER NOT NULL DEFAULT 0,
    fat_g INTEGER NOT NULL DEFAULT 0,
    confidence TEXT NOT NULL DEFAULT 'medium',
    source_note TEXT NOT NULL DEFAULT '',
    label_text TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL DEFAULT '',
    amount_known INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    original_id INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS meal_entries_thread ON meal_entries (conversation_id, active, created_at);
`);

export function saveMealEntry(conversationId, {
  mediaId = null, type, items, kcalLow, kcalLikely, kcalHigh,
  proteinG, carbsG, fatG, confidence, sourceNote = "", labelText = "",
  question = "", amountKnown = 0, originalId = null, at = clock.now(),
}) {
  if (mediaId) {
    const dup = db.prepare("SELECT id FROM meal_entries WHERE conversation_id = ? AND media_id = ? AND active = 1")
      .get(conversationId, mediaId);
    if (dup) return { id: dup.id, duplicate: true };
  }
  const r = db.prepare(`INSERT INTO meal_entries
    (conversation_id, media_id, type, items, kcal_low, kcal_likely, kcal_high,
     protein_g, carbs_g, fat_g, confidence, source_note, label_text, question,
     amount_known, active, original_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(conversationId, mediaId ?? null, type, JSON.stringify(items),
      kcalLow, kcalLikely, kcalHigh, proteinG, carbsG, fatG,
      confidence, sourceNote, labelText, question, amountKnown ? 1 : 0,
      originalId ?? null, at);
  return { id: Number(r.lastInsertRowid), duplicate: false };
}

export function mealEntriesSince(conversationId, sinceMs) {
  return db.prepare(
    "SELECT * FROM meal_entries WHERE conversation_id = ? AND active = 1 AND created_at >= ? ORDER BY created_at"
  ).all(conversationId, sinceMs).map(r => ({ ...r, items: JSON.parse(r.items || "[]") }));
}

export function mealEntryById(conversationId, id) {
  const r = db.prepare("SELECT * FROM meal_entries WHERE conversation_id = ? AND id = ?")
    .get(conversationId, id);
  return r ? { ...r, items: JSON.parse(r.items || "[]") } : null;
}

export function correctMealEntry(conversationId, entryId, updates) {
  const old = mealEntryById(conversationId, entryId);
  if (!old) return { ok: false, error: "entry not found" };
  if (!old.active) return { ok: false, error: "entry was already corrected" };
  db.prepare("UPDATE meal_entries SET active = 0 WHERE id = ?").run(entryId);
  const merged = {
    mediaId: old.media_id, type: updates.type ?? old.type,
    items: updates.items ?? old.items,
    kcalLow: updates.kcal_low ?? old.kcal_low,
    kcalLikely: updates.kcal_likely ?? old.kcal_likely,
    kcalHigh: updates.kcal_high ?? old.kcal_high,
    proteinG: updates.protein_g ?? old.protein_g,
    carbsG: updates.carbs_g ?? old.carbs_g,
    fatG: updates.fat_g ?? old.fat_g,
    confidence: updates.confidence ?? old.confidence,
    sourceNote: updates.source_note ?? old.source_note,
    labelText: updates.label_text ?? old.label_text,
    question: "", amountKnown: updates.amount_known ?? old.amount_known,
    originalId: old.original_id ?? old.id,
  };
  const r = saveMealEntry(conversationId, merged);
  return { ok: true, old_id: entryId, new_id: r.id };
}

// ---------- a standing commitment, and whether they showed up ----------
//
// Rows in and rows out. Which days a commitment falls on, when the grace window closes, what the
// progression line may say — all of that is src/commitment.js, and none of it is here.

/** The thing lowercased and squeezed, so "Leg day" and "leg  day" are one commitment. */
export const commitmentKey = (what) => String(what ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Write down what they said they would do, or update it when they change it.
 *
 * An update keeps the row — and therefore everything logged against it — so "actually make it 8"
 * does not lose the three sessions already on the books. A commitment that had been ended comes
 * back active, because saying it again IS starting it again.
 */
export function saveCommitment(conversationId, {
  what, days, atMin, timeZone, said = "", graceMin = 10, at = clock.now(),
}) {
  const key = commitmentKey(what);
  db.prepare(`INSERT INTO commitments
      (conversation_id, what, key, days, at_min, time_zone, grace_min, said, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(conversation_id, key) DO UPDATE SET
      what = excluded.what, days = excluded.days, at_min = excluded.at_min, time_zone = excluded.time_zone,
      grace_min = excluded.grace_min, said = excluded.said, state = 'active',
      updated_at = excluded.updated_at, ended_at = NULL, ended_why = ''`)
    .run(conversationId, String(what).slice(0, 200), key, JSON.stringify([...days].sort()), atMin,
      String(timeZone), graceMin, String(said ?? "").slice(0, 500), at, at);
  return commitmentByKey(conversationId, key);
}

export function commitmentByKey(conversationId, key) {
  return db.prepare("SELECT * FROM commitments WHERE conversation_id = ? AND key = ?")
    .get(conversationId, commitmentKey(key)) ?? null;
}

export function commitmentById(id) {
  return db.prepare("SELECT * FROM commitments WHERE id = ?").get(id) ?? null;
}

/** Everything they have standing. `state` null is every state, which is what a list for them wants. */
export function listCommitments(conversationId, { state = "active" } = {}) {
  return state === null
    ? db.prepare("SELECT * FROM commitments WHERE conversation_id = ? ORDER BY at_min ASC, id ASC").all(conversationId)
    : db.prepare("SELECT * FROM commitments WHERE conversation_id = ? AND state = ? ORDER BY at_min ASC, id ASC")
      .all(conversationId, state);
}

/** Every active commitment on the install, for the pass that has nobody to ask. */
export function activeCommitments() {
  return db.prepare("SELECT * FROM commitments WHERE state = 'active' ORDER BY conversation_id, id").all();
}

/**
 * Stop. 'paused' keeps the row and everything logged against it and stops the nudging; 'ended' is
 * them being done with it. Neither deletes a session they logged, because what they did happened.
 */
export function setCommitmentState(id, { state, why = "", at = clock.now() }) {
  db.prepare(`UPDATE commitments SET state = ?, ended_why = ?, updated_at = ?,
      ended_at = CASE WHEN ? = 'active' THEN NULL ELSE ? END WHERE id = ?`)
    .run(String(state), String(why ?? "").slice(0, 300), at, String(state), at, id);
  return commitmentById(id);
}

/**
 * One row per occurrence, replaced when they say more about the same one: a plain "went" at eight
 * and the numbers at nine are one session, not two.
 */
export function logSession(conversationId, { commitmentId, day, kind, items = [], atMin = null, said = "", at = clock.now() }) {
  db.prepare(`INSERT INTO commitment_logs (commitment_id, conversation_id, day, kind, items, at_min, said, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(commitment_id, day) DO UPDATE SET
      kind = excluded.kind, said = excluded.said, at = excluded.at,
      -- Numbers are never lost by a later, vaguer line about the same session. "went" after
      -- "squats 185x8" keeps the 185.
      items = CASE WHEN excluded.items = '[]' THEN commitment_logs.items ELSE excluded.items END,
      at_min = COALESCE(excluded.at_min, commitment_logs.at_min)`)
    .run(commitmentId, conversationId, String(day), String(kind), JSON.stringify(items ?? []),
      atMin, String(said ?? "").slice(0, 500), at);
  return sessionOn(commitmentId, day);
}

export function sessionOn(commitmentId, day) {
  return db.prepare("SELECT * FROM commitment_logs WHERE commitment_id = ? AND day = ?")
    .get(commitmentId, String(day)) ?? null;
}

/** What happened, newest first. The progression line is read off this and off nothing else. */
export function sessionLogs(commitmentId, { limit = 20 } = {}) {
  return db.prepare("SELECT * FROM commitment_logs WHERE commitment_id = ? ORDER BY day DESC, id DESC LIMIT ?")
    .all(commitmentId, limit);
}

// ---------- something they are trying to do, and the standing help for it ----------
//
// Rows in and rows out. Which goal may be pitched, what is still missing from its criteria, which
// matches are new — all of that is src/goals.js, and none of it is here.

/** The subject lowercased and squeezed, so "Job search" and "job  search" are one goal. */
export const goalKey = (what) => String(what ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);

/**
 * Write a goal down, or update the one already there.
 *
 * An update keeps the row, and therefore everything it carries: the criteria they have already
 * given, the matches already sent, and — most importantly — the fact that an offer was declined.
 * Mentioning the apartment hunt again must not quietly reset the no.
 *
 * The state is NEVER moved here. Saying the thing again is not accepting an offer, declining one, or
 * stopping a search, and a save that could flip any of those would be the write path arguing with
 * the three functions below that exist to do exactly one of them each.
 */
export function saveGoal(conversationId, { what, said = "", help = "", at = clock.now() }) {
  const key = goalKey(what);
  db.prepare(`INSERT INTO goals (conversation_id, what, key, said, help, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'noticed', ?, ?)
    ON CONFLICT(conversation_id, key) DO UPDATE SET
      what = excluded.what,
      said = CASE WHEN excluded.said = '' THEN goals.said ELSE excluded.said END,
      help = CASE WHEN excluded.help = '' THEN goals.help ELSE excluded.help END,
      updated_at = excluded.updated_at`)
    .run(conversationId, String(what).slice(0, 200), key, String(said ?? "").slice(0, 500),
      String(help ?? "").slice(0, 300), at, at);
  return goalByKey(conversationId, key);
}

export function goalByKey(conversationId, key) {
  return db.prepare("SELECT * FROM goals WHERE conversation_id = ? AND key = ?")
    .get(conversationId, goalKey(key)) ?? null;
}

export function goalById(conversationId, id) {
  return db.prepare("SELECT * FROM goals WHERE conversation_id = ? AND id = ?").get(conversationId, id) ?? null;
}

/** The goal a standing check-in is doing the looking for, if any. */
export function goalBySeries(seriesId) {
  return db.prepare("SELECT * FROM goals WHERE series_id = ?").get(seriesId) ?? null;
}

/** `states` null is every state, which is what a list for them wants. */
export function listGoals(conversationId, { states = null } = {}) {
  if (!states) return db.prepare("SELECT * FROM goals WHERE conversation_id = ? ORDER BY updated_at DESC").all(conversationId);
  const marks = states.map(() => "?").join(", ");
  return db.prepare(`SELECT * FROM goals WHERE conversation_id = ? AND state IN (${marks}) ORDER BY updated_at DESC`)
    .all(conversationId, ...states);
}

/** Every goal with a live search on the install, for the pass that has nobody to ask. */
export function runningGoals() {
  return db.prepare("SELECT * FROM goals WHERE state = 'running' ORDER BY conversation_id, id").all();
}

export function setGoalState(conversationId, id, state, { why = "", at = clock.now() } = {}) {
  const goal = goalById(conversationId, id);
  if (!goal) return { ok: false, error: `There is no goal #${id} in this conversation.` };
  db.prepare(`UPDATE goals SET state = ?, ended_why = ?, updated_at = ?,
      ended_at = CASE WHEN ? IN ('done', 'dropped') THEN ? ELSE NULL END WHERE id = ?`)
    .run(String(state), String(why ?? "").slice(0, 300), at, String(state), at, id);
  return { ok: true, goal: goalById(conversationId, id) };
}

/**
 * The criteria, merged rather than replaced, so a later answer never wipes an earlier one.
 *
 * `confirmed` is a separate write because it is a separate fact: a criterion Reason inferred from
 * something they said in passing and one they said yes to are not the same thing, and only the
 * second may start a standing search.
 */
export function setGoalCriteria(conversationId, id, criteria, { confirmed = undefined, at = clock.now() } = {}) {
  const goal = goalById(conversationId, id);
  if (!goal) return null;
  let current = {};
  try { current = JSON.parse(goal.criteria || "{}") ?? {}; } catch { current = {}; }
  const merged = { ...current };
  for (const [k, v] of Object.entries(criteria ?? {})) {
    // null is how a criterion is taken back; "" and undefined leave it alone.
    if (v === null) delete merged[k];
    else if (v !== undefined && v !== "") merged[k] = v;
  }
  // `confirmed` left out leaves the mark alone; a number sets it, and null clears it — which is
  // what a changed criterion does, because a yes to the old wording was not a yes to this one.
  const mark = confirmed === undefined ? goal.criteria_confirmed_at : confirmed;
  db.prepare("UPDATE goals SET criteria = ?, criteria_confirmed_at = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(merged), mark, at, id);
  return goalById(conversationId, id);
}

export function setGoalDelivery(conversationId, id, { cadence = undefined, delivery = undefined, at = clock.now() } = {}) {
  const goal = goalById(conversationId, id);
  if (!goal) return null;
  db.prepare("UPDATE goals SET cadence = ?, delivery = ?, updated_at = ? WHERE id = ?")
    .run(cadence === undefined ? goal.cadence : String(cadence ?? "").slice(0, 200),
      delivery === undefined ? goal.delivery : String(delivery ?? "").slice(0, 200), at, id);
  return goalById(conversationId, id);
}

/** The standing check-in that does the looking, tied to the goal it is for. */
export function attachGoalSeries(conversationId, id, seriesId, { at = clock.now() } = {}) {
  db.prepare("UPDATE goals SET series_id = ?, updated_at = ? WHERE conversation_id = ? AND id = ?")
    .run(seriesId, at, conversationId, id);
  return goalById(conversationId, id);
}

/** The standing help was pitched. Counted, because the count is what stops it being pitched again. */
export function markGoalOffered(conversationId, id, { said = "", at = clock.now() } = {}) {
  db.prepare(`UPDATE goals SET state = CASE WHEN state = 'noticed' THEN 'offered' ELSE state END,
      offered_at = ?, offers = offers + 1, offer_said = ?, updated_at = ? WHERE conversation_id = ? AND id = ?`)
    .run(at, String(said ?? "").slice(0, 500), at, conversationId, id);
  return goalById(conversationId, id);
}

/** They said no. Their words, kept, because this is the row that has to hold for months. */
export function markGoalDeclined(conversationId, id, { said = "", at = clock.now() } = {}) {
  db.prepare(`UPDATE goals SET state = 'declined', declined_at = ?, declined_said = ?, updated_at = ?
    WHERE conversation_id = ? AND id = ?`)
    .run(at, String(said ?? "").slice(0, 500), at, conversationId, id);
  return goalById(conversationId, id);
}

/**
 * One match, written down once. Returns `fresh` false when this exact thing has been seen before,
 * which is the whole of the deduplication: it is a UNIQUE constraint rather than a rule anybody has
 * to keep across weeks of trimmed conversation.
 */
export function recordGoalMatch(conversationId, goalId, { matchKey, title = "", url = "", detail = "", source = "", at = clock.now() }) {
  const key = String(matchKey ?? "").trim().toLowerCase().slice(0, 300);
  const existing = db.prepare("SELECT * FROM goal_matches WHERE goal_id = ? AND match_key = ?").get(goalId, key);
  if (existing) return { ...existing, fresh: false };
  db.prepare(`INSERT INTO goal_matches (goal_id, conversation_id, match_key, title, url, detail, source, found_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(goalId, conversationId, key, String(title).slice(0, 300), String(url).slice(0, 500),
      String(detail).slice(0, 500), String(source).slice(0, 200), at);
  const row = db.prepare("SELECT * FROM goal_matches WHERE goal_id = ? AND match_key = ?").get(goalId, key);
  return { ...row, fresh: true };
}

export function goalMatches(goalId, { limit = 20, sentOnly = false } = {}) {
  return db.prepare(`SELECT * FROM goal_matches WHERE goal_id = ?${sentOnly ? " AND sent_at IS NOT NULL" : ""}
    ORDER BY found_at DESC, id DESC LIMIT ?`).all(goalId, limit);
}

export function countGoalMatches(goalId) {
  const row = db.prepare("SELECT COUNT(*) AS found, SUM(sent_at IS NOT NULL) AS sent FROM goal_matches WHERE goal_id = ?")
    .get(goalId);
  return { found: Number(row?.found ?? 0), sent: Number(row?.sent ?? 0) };
}

/** These really went over. Claimed here so a second firing cannot show them again. */
export function markGoalMatchesSent(goalId, ids, { at = clock.now() } = {}) {
  if (!ids?.length) return 0;
  const marks = ids.map(() => "?").join(", ");
  const r = db.prepare(`UPDATE goal_matches SET sent_at = ? WHERE goal_id = ? AND sent_at IS NULL AND id IN (${marks})`)
    .run(at, goalId, ...ids);
  return Number(r.changes);
}

// ---------- per-message request tracking ----------

export function createRequest(conversationId, { handle, text }) {
  const r = db.prepare(
    "INSERT INTO requests (conversation_id, inbound_handle, text, kind, status, created_at) VALUES (?, ?, ?, 'pending', 'open', ?)",
  ).run(conversationId, handle ?? null, text ?? "", clock.now());
  return Number(r.lastInsertRowid);
}

/** Take back the request rows a drain made for a turn that never ran (src/down.js). */
export function forgetRequests(ids) {
  if (!ids?.length) return;
  db.prepare(`DELETE FROM requests WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  db.prepare(`DELETE FROM request_messages WHERE request_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
}

export function openRequests(conversationId) {
  return db.prepare(
    "SELECT * FROM requests WHERE conversation_id = ? AND status = 'open' ORDER BY id",
  ).all(conversationId);
}

export function classifyRequest(id, { kind, summary, correctsId }) {
  const fields = ["kind = ?"];
  const vals = [kind];
  if (summary != null) { fields.push("summary = ?"); vals.push(summary); }
  if (correctsId != null) { fields.push("corrects_id = ?"); vals.push(correctsId); }
  vals.push(id);
  return db.prepare(`UPDATE requests SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
}

export function answerRequest(id) {
  db.prepare("UPDATE requests SET status = 'answered', answered_at = ? WHERE id = ?").run(clock.now(), id);
}

export function dropRequest(id) {
  db.prepare("UPDATE requests SET status = 'dropped' WHERE id = ?").run(id);
}

export function dropStaleRequests(conversationId) {
  db.prepare("UPDATE requests SET status = 'dropped' WHERE conversation_id = ? AND status = 'open' AND kind = 'pending'")
    .run(conversationId);
}

export function getRequest(id) {
  return db.prepare("SELECT * FROM requests WHERE id = ?").get(id);
}

// ---------- one thought, one answer (src/onethought.js, src/said.js) ----------

export function linkRequestMessage(conversationId, requestId, messageId, role = "opened") {
  if (!requestId || !messageId) return;
  db.prepare("INSERT INTO request_messages (conversation_id, request_id, message_id, role, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(conversationId, requestId, String(messageId), role, clock.now());
}

export function requestMessages(conversationId, requestId) {
  return db.prepare("SELECT * FROM request_messages WHERE conversation_id = ? AND request_id = ? ORDER BY id").all(conversationId, requestId);
}

/** Append a continuation's words to the request it was folded into, so the row says the whole ask. */
export function extendRequestText(conversationId, requestId, more) {
  db.prepare("UPDATE requests SET text = text || ? WHERE conversation_id = ? AND id = ?").run(`\n${more ?? ""}`, conversationId, requestId);
}

/**
 * Take ONE held text out of the pile by its handle — a mid-turn text read as part of the request
 * already being worked on, which the running turn now owns. Same bargain as takePendingInbound:
 * read and delete with no await between, so a drain that got there first means this finds nothing.
 */
export function takePendingByHandle(conversationId, externalId) {
  const row = db.prepare("SELECT * FROM pending_inbound WHERE conversation_id = ? AND external_id = ? ORDER BY id LIMIT 1").get(conversationId, externalId);
  if (!row) return null;
  db.prepare("DELETE FROM pending_inbound WHERE id = ?").run(row.id);
  return { ...row, attachments: safeJson(row.attachments, []) };
}

/**
 * Reason Web §4h "take it back": the person takes one of their messages back before Reason starts on
 * it. The one transition that decides it is the held row's DELETE: a turn starts by taking the held
 * rows (takePendingInbound / takePendingByHandle, which delete them), so exactly one of the two finds
 * the row and the other finds nothing — never both. Same bargain as every take here: synchronous,
 * no await between read and delete, inside one IMMEDIATE transaction for good measure.
 *
 *   { ok: true, cancelled: true }                  taken back now; no turn will ever see it
 *   { ok: true, cancelled: true, already: true }   taken back before (a second tap, a retry)
 *   { ok: true, cancelled: true, early: true }     `inFlight` and not claimed yet: written down as
 *                                                  claimed-and-cancelled, so the send's own claim
 *                                                  (claimInbound) finds a duplicate and runs nothing
 *   { ok: false, why: "started" }                  the turn already took it: too late
 *   { ok: false, why: "not_found" | "not_yours" }  nothing of this conversation's by that id
 */
export function cancelHeldInbound({ conversationId, channel = "web", externalId, inFlight = false, now = clock.now() }) {
  if (!conversationId || !externalId) return { ok: false, why: "not_found" };
  db.exec("BEGIN IMMEDIATE");
  try {
    let out;
    const row = db.prepare("SELECT conversation_id, cancelled_at FROM inbound_messages WHERE channel = ? AND external_id = ?").get(channel, externalId);
    if (row && row.conversation_id !== conversationId) out = { ok: false, why: "not_yours" };
    else if (row && row.cancelled_at != null) out = { ok: true, cancelled: true, already: true };
    else if (!row) {
      if (!inFlight) out = { ok: false, why: "not_found" };
      else {
        db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at, cancelled_at) VALUES (?, ?, ?, ?, ?)")
          .run(channel, externalId, conversationId, now, now);
        out = { ok: true, cancelled: true, early: true };
      }
    } else {
      const gone = db.prepare("DELETE FROM pending_inbound WHERE conversation_id = ? AND channel = ? AND external_id = ?").run(conversationId, channel, externalId).changes;
      if (gone) {
        db.prepare("UPDATE inbound_messages SET cancelled_at = ? WHERE channel = ? AND external_id = ?").run(now, channel, externalId);
        out = { ok: true, cancelled: true };
      } else out = { ok: false, why: "started" };
    }
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already gone */ }
    throw e;
  }
}

/** Was this message taken back (§4h)? A read only. */
export function inboundCancelled(channel, externalId) {
  return db.prepare("SELECT cancelled_at FROM inbound_messages WHERE channel = ? AND external_id = ?").get(channel, externalId)?.cancelled_at != null;
}

/**
 * Reason Web §4h "while you were out": one page visit by this browser. A visit `awayMs` or more after
 * the last one starts a return (from the last visit to this one), kept on the session until the
 * thread shows it (takeWebAway). The first visit a browser ever makes has nothing to compare with.
 */
export function webVisit(token, { awayMs, now = clock.now() } = {}) {
  if (!token) return null;
  const row = db.prepare("SELECT web_seen_at FROM page_sessions WHERE token = ? AND conversation_id IS NOT NULL").get(sk(token));
  if (!row) return null;
  const prev = row.web_seen_at;
  if (prev != null && now - prev >= awayMs) {
    db.prepare("UPDATE page_sessions SET web_seen_at = ?, web_away_from = ?, web_away_to = ? WHERE token = ?").run(now, prev, now, sk(token));
    return { returned: true, from: prev, to: now };
  }
  db.prepare("UPDATE page_sessions SET web_seen_at = ? WHERE token = ?").run(now, sk(token));
  return { returned: false };
}

/** This browser is here (it sent something): its last-seen moves on, without starting a return. */
export function webPresent(token, now = clock.now()) {
  if (!token) return false;
  return db.prepare("UPDATE page_sessions SET web_seen_at = ? WHERE token = ? AND conversation_id IS NOT NULL").run(now, sk(token)).changes === 1;
}

/** Taken back after its claim but before it was held (src/channels/router.js takeBack): the hold then never happens. */
export function markInboundCancelled(channel, externalId, now = clock.now()) {
  return db.prepare("UPDATE inbound_messages SET cancelled_at = ? WHERE channel = ? AND external_id = ? AND cancelled_at IS NULL").run(now, channel, externalId).changes === 1;
}

/**
 * The return this browser has not been shown yet, spent as it is read (once per return): `{ from, to }`
 * or null. One older than `within` is spent and dropped: it belongs to a return that is over.
 */
export function takeWebAway(token, conversationId, { within = Infinity, now = clock.now() } = {}) {
  if (!token || !conversationId) return null;
  const row = db.prepare("SELECT web_away_from, web_away_to FROM page_sessions WHERE token = ? AND conversation_id = ?").get(sk(token), conversationId);
  if (row?.web_away_from == null) return null;
  const spent = db.prepare("UPDATE page_sessions SET web_away_from = NULL, web_away_to = NULL WHERE token = ? AND web_away_from IS NOT NULL").run(sk(token)).changes;
  if (!spent || now - row.web_away_to > within) return null;
  return { from: row.web_away_from, to: row.web_away_to };
}

export function addOpenQuestion(conversationId, { requestId = null, question }) {
  const q = String(question ?? "").trim().slice(0, 300);
  if (!q) return null;
  const r = db.prepare("INSERT INTO open_questions (conversation_id, request_id, question, created_at) VALUES (?, ?, ?, ?)")
    .run(conversationId, requestId, q, clock.now());
  return Number(r.lastInsertRowid);
}

export function closeOpenQuestion(conversationId, id, reason) {
  return Number(db.prepare("UPDATE open_questions SET status = 'closed', closed_reason = ?, closed_at = ? WHERE conversation_id = ? AND id = ? AND status = 'open'")
    .run(String(reason ?? "obsolete"), clock.now(), conversationId, id).changes);
}

/** Something they turned down that Reason raised, with no open question behind it: written closed. */
export function addDeclined(conversationId, { requestId = null, topic, words = "" }) {
  const t = String(topic ?? "").trim().slice(0, 200);
  if (!t) return null;
  const w = String(words ?? "").trim().slice(0, 120);
  const now = clock.now();
  const r = db.prepare("INSERT INTO open_questions (conversation_id, request_id, question, status, closed_reason, created_at, closed_at) VALUES (?, ?, ?, 'closed', 'declined', ?, ?)")
    .run(conversationId, requestId, w ? `${t} — they said "${w}"` : t, now, now);
  return Number(r.lastInsertRowid);
}

/** What they turned down, newest last. Kept off the short closed list: these are shown for months. */
export function declinedQuestions(conversationId, { since = 0, limit = 8 } = {}) {
  return db.prepare("SELECT * FROM open_questions WHERE conversation_id = ? AND status = 'closed' AND closed_reason = 'declined' AND closed_at >= ? ORDER BY closed_at DESC, id DESC LIMIT ?")
    .all(conversationId, since, limit).reverse();
}

export function openQuestions(conversationId, { since = 0, limit = 8 } = {}) {
  return db.prepare("SELECT * FROM open_questions WHERE conversation_id = ? AND status = 'open' AND created_at >= ? ORDER BY id DESC LIMIT ?")
    .all(conversationId, since, limit).reverse();
}

export function closedQuestions(conversationId, { since = 0, limit = 5 } = {}) {
  return db.prepare("SELECT * FROM open_questions WHERE conversation_id = ? AND status = 'closed' AND closed_reason IS NOT 'declined' AND closed_at >= ? ORDER BY closed_at DESC, id DESC LIMIT ?")
    .all(conversationId, since, limit).reverse();
}

export function addClaim(conversationId, { requestId = null, subject, value, certain = true }) {
  const s = String(subject ?? "").trim().slice(0, 160), v = String(value ?? "").trim().slice(0, 160);
  if (!s || !v) return null;
  const r = db.prepare("INSERT INTO sent_claims (conversation_id, request_id, subject, value, certain, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(conversationId, requestId, s, v, certain ? 1 : 0, clock.now());
  return Number(r.lastInsertRowid);
}

export function supersedeClaim(conversationId, id, { by = null, flagged = false } = {}) {
  return Number(db.prepare("UPDATE sent_claims SET status = 'superseded', superseded_by = ?, flagged = ?, superseded_at = ? WHERE conversation_id = ? AND id = ? AND status = 'standing'")
    .run(by, flagged ? 1 : 0, clock.now(), conversationId, id).changes);
}

export function standingClaims(conversationId, { since = 0, limit = 8 } = {}) {
  return db.prepare("SELECT * FROM sent_claims WHERE conversation_id = ? AND status = 'standing' AND created_at >= ? ORDER BY id DESC LIMIT ?")
    .all(conversationId, since, limit).reverse();
}

export function getClaim(conversationId, id) {
  return db.prepare("SELECT * FROM sent_claims WHERE conversation_id = ? AND id = ?").get(conversationId, id) ?? null;
}

/**
 * A draft that never went out comes off the thread, so the next turn does not read it as said.
 * Both backends save the turn's reply as the last assistant message; matched on its text, from the
 * end. The CLI path's thread is text only, so the line is removed. The API path's carries tool
 * blocks and has to keep alternating, so its text is replaced with a line saying it was not sent.
 */
export function retractDraft(conversationId, draft) {
  const want = String(draft ?? "").trim();
  if (!want) return false;
  const messages = loadConversation(conversationId);
  // Compared with whitespace folded: the API path joins its text blocks with newlines.
  const squash = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
  const textOf = (m) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join("\n") : "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || squash(textOf(m)) !== squash(want)) continue;
    if (typeof m.content === "string") messages.splice(i, 1);
    else m.content = [{ type: "text", text: "(draft not sent: they added more before it went out)" }];
    saveConversation(conversationId, messages);
    return true;
  }
  return false;
}

/** Take a line code wrote into a turn (src/onethought.js CODE_LINE) back off the thread. */
export function dropUserLineEndingWith(conversationId, mark) {
  const messages = loadConversation(conversationId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || typeof m.content !== "string" || !m.content.trimEnd().endsWith(mark)) continue;
    messages.splice(i, 1);
    saveConversation(conversationId, messages);
    return true;
  }
  return false;
}

/**
 * Their own lines, put into the thread just before Reason's last message — texts a running turn
 * took in mid-way through a tool result, which neither backend's history otherwise keeps.
 */
export function insertBeforeLastAssistant(conversationId, lines) {
  const add = (lines ?? []).filter(Boolean).map(content => ({ role: "user", content }));
  if (!add.length) return false;
  const messages = loadConversation(conversationId);
  let at = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") { at = i; break; }
  messages.splice(at, 0, ...add);
  saveConversation(conversationId, messages);
  return true;
}

// ---------- expense tracking ----------
//
// Rows in and rows out. Summaries, categories, and budgets are src/expenses.js, not here.

db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    their_words TEXT NOT NULL,
    date TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS expenses_by_conversation ON expenses (conversation_id, created_at);
`);

export function addExpense(conversationId, { amountCents, category, description, theirWords, date = "", at = clock.now() }) {
  const r = db.prepare(`INSERT INTO expenses (conversation_id, amount_cents, category, description, their_words, date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, amountCents, String(category).slice(0, 80), String(description).slice(0, 300),
      String(theirWords).slice(0, 500), String(date || ""), at);
  return getExpense(Number(r.lastInsertRowid));
}

export function getExpense(id) {
  return db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) ?? null;
}

export function listExpenses(conversationId, { since = 0, limit = 100 } = {}) {
  return db.prepare("SELECT * FROM expenses WHERE conversation_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?")
    .all(conversationId, since, limit);
}

export function deleteExpense(id) {
  return db.prepare("DELETE FROM expenses WHERE id = ?").run(id);
}

export function expenseSummary(conversationId, { since = 0 } = {}) {
  return db.prepare(`SELECT category, SUM(amount_cents) AS total_cents, COUNT(*) AS count
    FROM expenses WHERE conversation_id = ? AND created_at >= ?
    GROUP BY category ORDER BY total_cents DESC`).all(conversationId, since);
}

// ---------- grocery list ----------
//
// Rows in and rows out. The list itself, reorder logic, and categorisation are src/grocery.js, not here.

db.exec(`
  CREATE TABLE IF NOT EXISTS grocery_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    item TEXT NOT NULL,
    quantity TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    checked INTEGER NOT NULL DEFAULT 0,
    reorder_count INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL,
    bought_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS grocery_items_by_conversation ON grocery_items (conversation_id, checked, added_at);
`);

// ---------- persistent memory (Part 1) ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    tool_calls TEXT NOT NULL DEFAULT '[]',
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS event_log_conv ON event_log (conversation_id, at);

  -- One row per message a person sent or was sent, with where it happened (Reason Web, phase W0:
  -- docs/plans/reason-web-phase1.md §4.3). The model's thread (conversations.messages) is one JSON
  -- blob with no channel and no time on a line; event_log has both but is blanked after 30 days for
  -- memory's sake. Web's "your full conversation, with where each message came from" needs a row that
  -- is neither — so this is written alongside them, from the same moments, and nothing reads it yet.
  --
  --   role        user | assistant
  --   channel     sendblue | linq | console | fake | web — where THIS message happened
  --   external_id the provider's handle (inbound), or the sent message's id (outbound); the dedupe
  --   outbox_id   the outbox row an assistant message went out as, one history row per send
  --   media       JSON list of what was attached, as src/reviewed.js recorded it
  --   deleted_at  reserved; nothing writes it in v1 (§7 decision 7: no history deletion)
  --
  -- Written only while REASON_WEB is not off, for every conversation (src/web.js historyOn). Never
  -- backfilled: history starts the day the switch is turned, and Web says so.
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    channel TEXT NOT NULL,
    external_id TEXT,
    outbox_id INTEGER,
    text TEXT NOT NULL DEFAULT '',
    media TEXT NOT NULL DEFAULT '[]',
    at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS messages_conv_at ON messages (conversation_id, at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS messages_inbound_once ON messages (conversation_id, channel, external_id) WHERE external_id IS NOT NULL AND role = 'user';
  CREATE UNIQUE INDEX IF NOT EXISTS messages_outbox_once ON messages (outbox_id) WHERE outbox_id IS NOT NULL;
  -- Web-only chats (owner 10-27): one row per chat Home's composer started, owned by one conversation.
  CREATE TABLE IF NOT EXISTS web_chats (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS web_chats_conv ON web_chats (conversation_id, last_at);

  -- Which messages belong to which task (Reason Web v2, "done things settle", src/settle.js). Written
  -- at the end of a turn that worked on a task — started it, updated it, finished it, or was its own
  -- wake — for that turn's own texts (by their handle, = messages.external_id) and what it sent (by
  -- outbox row, = messages.outbox_id). Never guessed from words or from time.
  CREATE TABLE IF NOT EXISTS task_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    external_id TEXT,
    outbox_id INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS task_messages_in ON task_messages (conversation_id, task_id, external_id) WHERE external_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS task_messages_out ON task_messages (conversation_id, task_id, outbox_id) WHERE outbox_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS task_messages_task ON task_messages (conversation_id, task_id);

  -- The kind of device a Web message was typed on (phone | tablet | computer), read off the sending
  -- browser's User-Agent at the moment it was sent; keyed by the browser's own message id. The
  -- thread's "where you are" note says "on your phone" / "on your laptop" from this, never a guess.
  CREATE TABLE IF NOT EXISTS web_devices (
    conversation_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    device TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, client_id)
  );

  CREATE TABLE IF NOT EXISTS fact_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    fact_id INTEGER NOT NULL,
    source_table TEXT NOT NULL DEFAULT 'person_facts',
    embedding BLOB NOT NULL,
    model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    created_at INTEGER NOT NULL,
    UNIQUE(fact_id, source_table)
  );
  CREATE INDEX IF NOT EXISTS fact_embeddings_conv ON fact_embeddings (conversation_id);
  -- What they asked Reason to forget, kept out of recall (src/recallindex.js) for good: the call,
  -- message or action row itself stays (it is their conversation), its vector goes, and this says
  -- never to index or show it again (src/db.js forgetFromRecall).
  CREATE TABLE IF NOT EXISTS recall_forgotten (
    conversation_id TEXT NOT NULL,
    source_table TEXT NOT NULL,
    row_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, source_table, row_id)
  );
  -- An exchange whose vector a forget deleted (one of its lines named them): the lines left in it are
  -- indexed again by src/recallindex.js, without the forgotten ones, so the rest of what was said
  -- stays findable — the indexer otherwise only moves forward (review 11-07).
  CREATE TABLE IF NOT EXISTS recall_reindex (
    conversation_id TEXT NOT NULL,
    span_from INTEGER NOT NULL,
    span_to INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, span_from)
  );

  -- episodes and thread_summaries used to be here. Neither was ever read; the first was written by
  -- the extractor every turn and the second by nothing. Dropped below, rows and all (audit 10-18).
  DROP TABLE IF EXISTS episodes;
  DROP TABLE IF EXISTS thread_summaries;

  CREATE TABLE IF NOT EXISTS extraction_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    event_log_id INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    processed_at INTEGER,
    UNIQUE(event_log_id)
  );
  CREATE INDEX IF NOT EXISTS extraction_queue_due ON extraction_queue (state, created_at);

  CREATE TABLE IF NOT EXISTS profile_blocks (
    conversation_id TEXT PRIMARY KEY,
    block TEXT NOT NULL DEFAULT '',
    fact_ids TEXT NOT NULL DEFAULT '[]',
    built_at INTEGER NOT NULL
  );

  -- knowledge graph (Part 2)

  CREATE TABLE IF NOT EXISTS graph_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    type TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    key TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    person_id INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    merged_into INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(conversation_id, type, key)
  );
  CREATE INDEX IF NOT EXISTS graph_entities_conv ON graph_entities (conversation_id, type);
  CREATE INDEX IF NOT EXISTS graph_entities_person ON graph_entities (person_id);

  CREATE TABLE IF NOT EXISTS graph_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    src_entity INTEGER NOT NULL,
    relation TEXT NOT NULL,
    dst_entity INTEGER NOT NULL,
    properties TEXT NOT NULL DEFAULT '{}',
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    superseded_by INTEGER,
    confidence REAL NOT NULL DEFAULT 1.0,
    source TEXT NOT NULL DEFAULT 'inferred',
    source_message_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS graph_edges_src ON graph_edges (conversation_id, src_entity);
  CREATE INDEX IF NOT EXISTS graph_edges_dst ON graph_edges (conversation_id, dst_entity);

  CREATE TABLE IF NOT EXISTS graph_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    event_log_id INTEGER NOT NULL,
    entity_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(event_log_id, entity_id)
  );
  CREATE INDEX IF NOT EXISTS graph_mentions_entity ON graph_mentions (conversation_id, entity_id);

  CREATE TABLE IF NOT EXISTS graph_merge_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    entity_a INTEGER NOT NULL,
    entity_b INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    UNIQUE(conversation_id, entity_a, entity_b)
  );
`);

// Web-only chats (owner 10-27): the chat a row belongs to; null = the shared thread (iMessage + Web).
addColumnIfMissing("messages", "chat_id", "TEXT");
// …and the thread an approval was asked in (its history key; null = the shared thread), so only an
// answer in that same thread can grant it (src/trust.js recordConfirmation).
addColumnIfMissing("confirmations", "thread_key", "TEXT");
// …and which of the owner's texts in that thread said the yes (its 1-based place among them, the same
// count asked_after_msgs keeps), so one reply is a yes to one ask only (security audit 2026-11-06, lead 27).
addColumnIfMissing("confirmations", "granted_by_msg", "INTEGER");
// …and the newest ask that existed at that moment: only an ask already open then was waiting on that
// same reply. One opened later (a new chat, a test's fresh ask) never shared it.
addColumnIfMissing("confirmations", "granted_upto_id", "INTEGER");
// …and each Web chat's short title (src/webchats.js), written once when its first reply lands.
addColumnIfMissing("web_chats", "title", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS messages_chat_at ON messages (conversation_id, chat_id, at, id) WHERE chat_id IS NOT NULL");
// …and where a row came from when that is not the conversation itself: 'ops' for the owner's status
// alerts and other operator notices (OPS_KEY_PREFIXES, tagged by their sender's outbox key). They stay
// in the thread; Home's Overnight lists only what Reason did for the person (src/daily.js, 10-27).
addColumnIfMissing("messages", "source", "TEXT");
// …and, for the iPhone app (2026-11-09): on Reason's rows, the id of the person's row it answers (from the
// outbox's answers_handle; NULL when it answered nobody), and 1 on the last reply of a finished turn; on the
// person's rows, when the turn answering them ended (NULL while it runs, or for rows older than this).
addColumnIfMissing("messages", "reply_to_id", "INTEGER");
addColumnIfMissing("messages", "turn_last", "INTEGER");
addColumnIfMissing("messages", "turn_done_at", "INTEGER");


// Temporal columns on person_facts
addColumnIfMissing("person_facts", "valid_from", "INTEGER");
addColumnIfMissing("person_facts", "valid_to", "INTEGER");
addColumnIfMissing("person_facts", "status", "TEXT NOT NULL DEFAULT 'active'");
addColumnIfMissing("person_facts", "superseded_by", "INTEGER");
addColumnIfMissing("person_facts", "confidence", "REAL NOT NULL DEFAULT 1.0");
addColumnIfMissing("person_facts", "source", "TEXT NOT NULL DEFAULT 'user_stated'");
addColumnIfMissing("person_facts", "source_message_ids", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("person_facts", "category", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("person_facts", "memory_group", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("saved_places", "mode", "TEXT");
addColumnIfMissing("saved_places", "travel_minutes", "INTEGER");
addColumnIfMissing("saved_places", "route_description", "TEXT");
// A past-messages entry in fact_embeddings covers a run of event_log rows (src/recallindex.js): fact_id is
// the last of them and span_from the first, so the snippet is read back from the rows themselves.
addColumnIfMissing("fact_embeddings", "span_from", "INTEGER");

db.prepare("UPDATE person_facts SET valid_from = created_at WHERE valid_from IS NULL").run();
// The backlog of duplicated facts, duplicated subjects and names-as-facts. Defined up with
// `remember`, which is what stops them coming back; run here because it reads the columns and the
// fact_embeddings table that the migrations above are what guarantee.
tidyPersonFacts();
foldSameNameEntities();
// And the layer above it: subjects that were identifiers, and the account bookkeeping filed under
// them. Separately marked, because every install has already run the pass above.
tidyIdentifierSubjects();

// -- event_log queries --

export function writeEvent({ conversationId, channel = "", messageId = "", threadId = null, role, content, attachments = [], toolCalls = [], at = clock.now() }) {
  const r = db.prepare(
    `INSERT INTO event_log (conversation_id, channel, message_id, thread_id, role, content, attachments, tool_calls, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(conversationId, channel, messageId, threadId, role, restcrypt.sealFor(conversationId, String(content ?? "")), JSON.stringify(attachments), restcrypt.sealFor(conversationId, JSON.stringify(toolCalls)), at);
  return Number(r.lastInsertRowid);
}

// -- messages (per-message history with source channel; Reason Web W0) --

/** Is the per-message history being written at all? Read from config here rather than src/web.js, which imports this file. */
function historyOn() {
  return config.web === "owner" || config.web === true;
}

/**
 * Messages Reason wrote that are not part of anybody's conversation: a sign-in code is a secret,
 * never shown in history (§4.3), and nothing else is excluded. Matched on the outbox key's prefix,
 * which is the one thing a code-writing caller sets on purpose: `pcode:` is a page's or /ops's gate
 * (src/http.js), `esign:` an event sign-in (src/pages/event.js), `wsign:` Web's own (W1), `scode:` the
 * code that starts a remote sign-in link (src/signin-remote.js, lead 6).
 */
export const HISTORY_EXCLUDED_KEYS = ["pcode:", "esign:", "wsign:", "scode:"];

/**
 * Outbox keys of operator notices: the status check's texts (`ops:`, src/ops.js), alerts raised at the
 * point of failure (`incident:`, src/incidents.js) and "a new event was made" (`event-created:`,
 * src/eventtools.js). Their history row is tagged `source = 'ops'` — the sender says what it is, so
 * nothing has to read the words to tell an alert from news.
 */
export const OPS_KEY_PREFIXES = ["ops:", "incident:", "event-created:"];
export const opsSourceOf = (idemKey) => OPS_KEY_PREFIXES.some(p => String(idemKey ?? "").startsWith(p)) ? "ops" : null;

// Rows written before the tag (10-27): the keyed notices by their outbox key, and the status check's
// texts — sent under an automatic key until then — by what only that code wrote: the status page's
// link, or the check's fixed opening line. Every part of a split message goes with its first.
{
  // The part number is the LAST `#n` (src/outbox.js sendSequence), so cut there: rtrim the digits, then the `#`.
  const base = (col) => `CASE WHEN ${col} GLOB '*#[0-9]*' THEN rtrim(rtrim(${col}, '0123456789'), '#') ELSE ${col} END`;
  const keyed = OPS_KEY_PREFIXES.map(() => "substr(o.idem_key, 1, ?) = ?").join(" OR ");
  db.prepare(`UPDATE messages SET source = 'ops' WHERE source IS NULL AND role = 'assistant' AND (
      pt(text) LIKE '%/ops?k=%' OR pt(text) LIKE 'Reason check —%'
      OR outbox_id IN (SELECT o.id FROM outbox o WHERE ${keyed} OR ${base("o.idem_key")} IN (
        SELECT ${base("h.idem_key")} FROM outbox h JOIN messages hm ON hm.outbox_id = h.id
        WHERE pt(hm.text) LIKE '%/ops?k=%' OR pt(hm.text) LIKE 'Reason check —%')))`)
    .run(...OPS_KEY_PREFIXES.flatMap(p => [p.length, p]));
}

let webChatReplyHook = null;
/** src/webchats.js's titler: called with (conversationId, chatId) for each reply row written into a Web chat. */
export function setWebChatReplyHook(f) { webChatReplyHook = typeof f === "function" ? f : null; }

/**
 * One history row. Idempotent on (conversation, channel, external_id) for a person's message and on
 * outbox_id for Reason's, so a retried webhook or a second markOutboundSent writes nothing twice.
 * Returns the row id, or null when nothing was written (switch off, duplicate, empty).
 */
export function writeMessage({ conversationId, role, channel, externalId = null, outboxId = null, text = "", media = [], at = clock.now(), chatId = null, source = null, replyToId = null }) {
  if (!historyOn()) return null;
  if (!conversationId || !role || !channel) return null;
  const body = String(text ?? "");
  const atts = Array.isArray(media) ? media : [];
  if (!body.trim() && !atts.length) return null;
  // A Web-only chat's row (Home's composer, owner 10-27): only ever on the web channel, only ever a
  // chat this conversation owns. Anything else is the shared thread's.
  const chat = channel === "web" ? webChatOf(chatId) : null;
  const ownChat = chat && webChatOwner(chat) === conversationId ? chat : null;
  const r = db.prepare(`INSERT OR IGNORE INTO messages (conversation_id, role, channel, external_id, outbox_id, text, media, at, chat_id, source, reply_to_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, role, channel, externalId == null ? null : String(externalId), outboxId ?? null, restcrypt.sealFor(conversationId, body), JSON.stringify(atts), at, ownChat, source === "ops" ? "ops" : null,
      role === "assistant" && Number.isInteger(replyToId) ? replyToId : null);
  if (!r.changes) return null;
  const id = Number(r.lastInsertRowid);
  if (ownChat) db.prepare("UPDATE web_chats SET last_at = ? WHERE id = ?").run(Math.max(at, clock.now()), ownChat);
  // Live Web (W2): an open conversation tab hears about its own conversation's new row, nothing else.
  try { historyBus.emit("row", { conversationId, id, chatId: ownChat }); } catch { /* a listener never costs a write */ }
  // A reply landing in a Web chat: what titles it, once (src/webchats.js).
  if (ownChat && role === "assistant" && webChatReplyHook) { try { webChatReplyHook(conversationId, ownChat); } catch { /* never costs a write */ } }
  return id;
}

// ---------------------------------------------------------------- Web-only chats (owner 10-27)
// Home's composer starts a chat of its own: a clean page with only that exchange, its own model
// context (`historyKeyFor`), its replies only on Web. Everything else — memory, tasks, Ongoing, Saved,
// approvals — stays the person's, under their conversation_id. The id is the browser's (minted by the
// page, 128 bits); the first send claims it for that conversation and it is nobody else's after.
export const WEB_CHAT_RE = /^[A-Za-z0-9_-]{22}$/;
const WEB_CHAT_PREFIX = "web:";
/** The chat id inside a web route's chatId ("web:<id>"), or null. */
export function webChatOf(chatId) {
  const s = String(chatId ?? "");
  if (!s.startsWith(WEB_CHAT_PREFIX)) return null;
  const id = s.slice(WEB_CHAT_PREFIX.length);
  return WEB_CHAT_RE.test(id) ? id : null;
}
export const webChatRoute = (id) => `${WEB_CHAT_PREFIX}${id}`;
/** The model's history key for a turn in this chat: its own, never the shared thread's. */
export const historyKeyFor = (conversationId, chatId) => {
  const chat = webChatOf(chatId);
  return chat && webChatOwner(chat) === conversationId ? `${conversationId}#web:${chat}` : conversationId;
};
export function webChatOwner(id) {
  return WEB_CHAT_RE.test(String(id ?? "")) ? db.prepare("SELECT conversation_id FROM web_chats WHERE id = ?").get(String(id))?.conversation_id ?? null : null;
}
/** Make (or find) this conversation's chat `id`. False when the id is somebody else's or malformed. */
export function claimWebChat(conversationId, id) {
  if (!conversationId || !WEB_CHAT_RE.test(String(id ?? ""))) return false;
  const now = clock.now();
  db.prepare("INSERT OR IGNORE INTO web_chats (id, conversation_id, created_at, last_at) VALUES (?, ?, ?, ?)").run(String(id), conversationId, now, now);
  return webChatOwner(id) === conversationId;
}
/** This conversation's Web chats that have anything in them, newest first: `{ id, created_at, last_at, title, count, first }`. */
export function listWebChats(conversationId) {
  return db.prepare(`SELECT c.id, c.created_at, c.last_at, c.title, COUNT(m.id) AS count,
      (SELECT text FROM messages f WHERE f.conversation_id = c.conversation_id AND f.chat_id = c.id AND f.deleted_at IS NULL AND f.role = 'user' ORDER BY f.at, f.id LIMIT 1) AS first
    FROM web_chats c JOIN messages m ON m.conversation_id = c.conversation_id AND m.chat_id = c.id AND m.deleted_at IS NULL
    WHERE c.conversation_id = ? GROUP BY c.id ORDER BY c.last_at DESC`).all(conversationId);
}

/** New history rows, as `row` events `{ conversationId, id }`. In-process: the SSE route listens, per conversation. */
export const historyBus = new EventEmitter();
historyBus.setMaxListeners(0);

/**
 * Errands finishing, as events (2026-10-27, src/stamps.js): `task` { conversationId, id } when a task
 * is closed done, `call` { conversationId, id } when a call's outcome is written, `purchase`
 * { buyConversationId } when an order is placed or a ticket issued, `research` { conversationId, id }
 * when a research run is closed done. Told after the write, and a
 * listener's failure never costs the write. Nobody listens unless src/stamps.js is loaded.
 */
export const completionBus = new EventEmitter();
completionBus.setMaxListeners(0);
function emitCompletion(kind, info) {
  try { completionBus.emit(kind, info); } catch { /* a listener never costs a write */ }
}

/**
 * A job changed — its state, its sheet, its log, or a call's outcome written onto it — as `changed`
 * events `{ conversationId, id }` (2026-10-30, src/todo.js: the checklist page of a to-do list is
 * redrawn from its jobs). conversationId may be null when only the task id is in hand. Told after the
 * write; a listener's failure never costs the write.
 */
export const taskBus = new EventEmitter();
taskBus.setMaxListeners(0);
function taskChanged(conversationId, id) {
  try { taskBus.emit("changed", { conversationId, id }); } catch { /* a listener never costs a write */ }
}

/**
 * One page of older history: the `limit` rows just before row `before` (by time, then id), oldest
 * first. Scoped by conversation like every read here; a `before` from another conversation finds
 * nothing to stand on and returns nothing.
 */
// The shared thread is every row with no chat; a Web chat is its own rows only.
const chatWhere = (chat) => (chat ? { sql: "chat_id = ?", args: [String(chat)] } : { sql: "chat_id IS NULL", args: [] });
export function messagesBefore(conversationId, { before = null, limit = 40, chat = null } = {}) {
  const parse = (r) => ({ ...r, media: (() => { try { return JSON.parse(r.media || "[]"); } catch { return []; } })() });
  const c = chatWhere(chat);
  let rows;
  if (before == null) {
    rows = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND ${c.sql} AND deleted_at IS NULL
      ORDER BY at DESC, id DESC LIMIT ?`).all(conversationId, ...c.args, limit);
  } else {
    const at = db.prepare(`SELECT at FROM messages WHERE id = ? AND conversation_id = ? AND ${c.sql}`).get(before, conversationId, ...c.args)?.at;
    if (at == null) return [];
    rows = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND ${c.sql} AND deleted_at IS NULL
      AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?`).all(conversationId, ...c.args, at, at, before, limit);
  }
  return rows.reverse().map(parse);
}

/** Record the first Web visit; true only the first time (the boundary note shows that once). */
export function markWebNoticeSeen(conversationId) {
  return db.prepare("UPDATE accounts SET web_notice_seen_at = ? WHERE conversation_id = ? AND web_notice_seen_at IS NULL")
    .run(clock.now(), conversationId).changes === 1;
}

/**
 * When Web's history begins for this conversation, if it holds less than the conversation: the day
 * the `messages` table began (never backfilled, so its oldest row site-wide), when this person's
 * account or texts are older than that. Null when nothing is missing (their whole conversation
 * started after Web history did) or when there is no history yet.
 */
export function historyStartFor(conversationId) {
  const start = db.prepare("SELECT MIN(at) AS at FROM messages").get()?.at;
  if (start == null) return null;
  const began = db.prepare(`SELECT MIN(t) AS at FROM (
      SELECT created_at AS t FROM accounts WHERE conversation_id = ?
      UNION ALL SELECT MIN(at) FROM event_log WHERE conversation_id = ?)`).get(conversationId, conversationId)?.at;
  return began != null && began < start ? start : null;
}

/**
 * The history row for a message that just left through the outbox. To the person whose Reason it
 * is only (`to_owner`): a text Reason sent somebody else on their behalf is that errand's business,
 * recorded by the tool that sent it, not a line in this person's conversation.
 */
function historyFromOutbound(row) {
  if (!row || !historyOn()) return null;
  if (!row.to_owner) return null;
  if (HISTORY_EXCLUDED_KEYS.some(p => String(row.idem_key ?? "").startsWith(p))) return null;
  // A choice card is a picture Reason drew, kept on this machine, so Web can draw it in the thread too.
  const card = /[\\/]choice-cards[\\/]([0-9a-f]{20}\.jpg)$/.exec(String(row.media?.file ?? ""));
  // A table picture (src/tableimage.js) went by address, an upload of this conversation's (marked `table`
  // by the tool that drew it): Web serves it from there. Any other address (a contact card's .vcf) stays a file.
  const table = row.media?.table === true && /^https?:\/\/.+\/web\/media\/u\//.test(String(row.media.mediaUrl ?? ""))
    && /^image\//.test(String(row.media.mimeType ?? "image/png"));
  // A welcome card (src/welcome.js) is history as its words: Web cannot draw the picture, and a blank file says nothing.
  const media = !row.media || row.media.fallbackText || row.media.carousel ? []
    : card ? [{ kind: "image", mimeType: "image/jpeg", filename: row.media.filename ?? null, url: `card:${card[1]}`, choice: true }]
      : table ? [{ kind: "image", mimeType: row.media.mimeType ?? "image/png", filename: row.media.filename ?? null, url: row.media.mediaUrl, table: true }]
        : [{ kind: "file", mimeType: row.media.mimeType ?? null, filename: row.media.filename ?? null }];
  return writeMessage({
    conversationId: row.conversation_id, role: "assistant", channel: row.channel,
    externalId: row.message_id ?? null, outboxId: row.id, text: row.body || (row.media?.fallbackText ? `(picture) ${row.media.fallbackText}` : row.media?.historyText ?? ""), media, at: row.sent_at ?? clock.now(),
    chatId: row.chat_id ?? null, source: opsSourceOf(row.idem_key),
    replyToId: row.answers_handle ? userRowIdOf(row.conversation_id, row.answers_handle) : null,
  });
}

/**
 * The names this person's Reason keeps about other people (`people`, `important_people`), for the iPhone
 * app's progress lines (src/progress.js): a search naming one of them is never spelled out. This
 * conversation's only.
 */
export function knownNamesOf(conversationId) {
  if (!conversationId) return [];
  const rows = db.prepare(`SELECT name AS n FROM people WHERE conversation_id = ?
    UNION SELECT who AS n FROM important_people WHERE conversation_id = ? LIMIT 2000`).all(conversationId, conversationId);
  return rows.map(r => String(r.n ?? "").trim()).filter(Boolean);
}

/** The history row id of the person's message with this inbound handle, in this conversation only. */
export function userRowIdOf(conversationId, handle) {
  if (!conversationId || handle == null || handle === "") return null;
  return db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' AND external_id = ? ORDER BY id DESC LIMIT 1")
    .get(conversationId, String(handle))?.id ?? null;
}

/**
 * A turn ended (src/channels/router.js): the person's rows it answered get `turn_done_at`, and the newest of
 * Reason's rows answering any of them gets `turn_last`. Told on historyBus as `turn` { conversationId, ids,
 * replyTo, lastReply, at } so an open app stream says so at once. Returns that event, or null when none of
 * the handles has a history row (history off, or a turn that wrote none).
 */
export function finishTurn(conversationId, handles, { at = clock.now() } = {}) {
  if (!conversationId || !handles?.length) return null;
  const ids = handles.map(h => userRowIdOf(conversationId, h)).filter(id => id != null);
  if (!ids.length) return null;
  const marks = ids.map(() => "?").join(",");
  db.prepare(`UPDATE messages SET turn_done_at = ? WHERE conversation_id = ? AND role = 'user' AND turn_done_at IS NULL AND id IN (${marks})`).run(at, conversationId, ...ids);
  const last = db.prepare(`SELECT MAX(id) AS id FROM messages WHERE conversation_id = ? AND role = 'assistant' AND deleted_at IS NULL AND reply_to_id IN (${marks})`).get(conversationId, ...ids)?.id ?? null;
  if (last != null) db.prepare("UPDATE messages SET turn_last = 1 WHERE id = ? AND conversation_id = ?").run(last, conversationId);
  const event = { conversationId, ids, replyTo: ids.at(-1), lastReply: last, at };
  try { historyBus.emit("turn", event); } catch { /* a listener never costs a write */ }
  return event;
}

/** This conversation's history, oldest first, after a row id. Scoped by conversation: never anybody else's. */
export function messagesFor(conversationId, { after = 0, limit = 200, chat = null } = {}) {
  const c = chatWhere(chat);
  return db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND ${c.sql} AND id > ? AND deleted_at IS NULL
    ORDER BY at ASC, id ASC LIMIT ?`).all(conversationId, ...c.args, after, limit)
    .map(r => ({ ...r, media: (() => { try { return JSON.parse(r.media || "[]"); } catch { return []; } })() }));
}

/** The newest history rows (or those before `before`), oldest of them first. */
export function latestMessagesFor(conversationId, { before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
  const c = chatWhere(null);
  return db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND ${c.sql} AND id < ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`)
    .all(conversationId, ...c.args, before, limit).reverse()
    .map(r => ({ ...r, media: (() => { try { return JSON.parse(r.media || "[]"); } catch { return []; } })() }));
}

/**
 * Did a web message with these words go to this address in the window? Asked by the web channel's
 * findSent after a crash, through the outbox row the history row was written off, so the address is
 * the outbox's and two people typing the same words never answer for each other.
 */
export function webMessageSent({ address, text, since, until }) {
  return db.prepare(`SELECT m.external_id, m.at FROM messages m JOIN outbox o ON o.id = m.outbox_id
    WHERE m.channel = 'web' AND pt(o.address) = ? AND pt(o.body) = ? AND m.at >= ? AND m.at <= ?
    ORDER BY m.at DESC LIMIT 1`).get(address, text, since, until) ?? null;
}

export function eventsSince(conversationId, sinceAt, { limit = 100 } = {}) {
  return db.prepare("SELECT * FROM event_log WHERE conversation_id = ? AND at > ? ORDER BY at LIMIT ?")
    .all(conversationId, sinceAt, limit);
}

export function recentEvents(conversationId, { limit = 20 } = {}) {
  return db.prepare("SELECT * FROM event_log WHERE conversation_id = ? ORDER BY at DESC LIMIT ?")
    .all(conversationId, limit);
}

/**
 * What the person themselves put in front of Reason since `since`, as text: their own messages
 * (voice notes arrive transcribed), and what was read off the photos and recordings they sent — the
 * photo note's words, a recording's transcript. The reply check (src/offers.js guardReply) counts a
 * figure in any of these as theirs, never something to hedge. Scoped by conversation.
 */
export function theirOwnWords(conversationId, { since = 0, limit = 400 } = {}) {
  const said = db.prepare(`SELECT content AS text, at, 'them' AS kind FROM event_log
    WHERE conversation_id = ? AND role = 'user' AND at >= ? ORDER BY at DESC LIMIT ?`).all(conversationId, since, limit);
  // A photo's note counts only when the photo read wrote it (description_from = 'photo'): the fallback
  // note is Reason's own reply, never theirs (review 11-07).
  const sent = db.prepare(`SELECT TRIM(CASE WHEN description_from = 'photo' THEN COALESCE(description, '') ELSE '' END || ' ' || COALESCE(transcript, '')) AS text, at, 'sent' AS kind FROM media_items
    WHERE conversation_id = ? AND at >= ? AND ((description_from = 'photo' AND COALESCE(description, '') != '') OR COALESCE(transcript, '') != '')
    ORDER BY id DESC LIMIT ?`).all(conversationId, since, limit);
  return [...said, ...sent];
}

// -- profile_blocks queries --

export function getProfile(conversationId) {
  return db.prepare("SELECT * FROM profile_blocks WHERE conversation_id = ?").get(conversationId) ?? null;
}

export function saveProfile(conversationId, block, factIds, { at = clock.now() } = {}) {
  db.prepare(
    `INSERT INTO profile_blocks (conversation_id, block, fact_ids, built_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET block = excluded.block, fact_ids = excluded.fact_ids, built_at = excluded.built_at`
  ).run(conversationId, block, JSON.stringify(factIds), at);
}

export function invalidateProfile(conversationId) {
  db.prepare("DELETE FROM profile_blocks WHERE conversation_id = ?").run(conversationId);
}

// -- extraction_queue queries --

// When a row that failed for an outage may be tried again (see markExtractionFailed).
addColumnIfMissing("extraction_queue", "retry_at", "INTEGER");

/**
 * An error that says the model could not be reached, rather than that this message could not be
 * read: no credit, rate limited, overloaded, a 5xx, the network. On 2026-10-22/23 the API account
 * ran out of credit for hours; 30 messages used their three tries inside that window and sat
 * 'pending' for good, their facts never extracted, though nothing was wrong with any of them.
 */
// The CLI's own words for the same thing (2026-10-25, extraction moved onto the subscription): a
// limit hit, a run that did not finish in time, a run a restart stopped.
export const EXTRACTION_OUTAGE = /credit balance|rate.?limit|\b429\b|overloaded|\b529\b|\b50[0234]\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|timed? ?out|connection error|session limit|usage limit|hit your .*limit|stopped by SIG|could not run 'claude'/i;
const OUTAGE_RETRY_MS = 5 * 60_000;

/** Take back an event row, and its extraction, written for a turn that never ran (src/down.js). */
export function forgetEvent(id) {
  db.prepare("DELETE FROM extraction_queue WHERE event_log_id = ?").run(id);
  db.prepare("DELETE FROM event_log WHERE id = ?").run(id);
}

export function enqueueExtraction(conversationId, eventLogId, { at = clock.now() } = {}) {
  try {
    db.prepare("INSERT INTO extraction_queue (conversation_id, event_log_id, created_at) VALUES (?, ?, ?)")
      .run(conversationId, eventLogId, at);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return;
    throw e;
  }
}

export function claimExtractions({ limit = 5 } = {}) {
  const rows = db.prepare(
    "SELECT * FROM extraction_queue WHERE state = 'pending' AND attempts < 3 AND (retry_at IS NULL OR retry_at <= ?) ORDER BY created_at LIMIT ?"
  ).all(clock.now(), limit);
  for (const r of rows) {
    db.prepare("UPDATE extraction_queue SET state = 'processing', attempts = attempts + 1 WHERE id = ?").run(r.id);
  }
  return rows;
}

/**
 * Rows a stopped process left 'processing', put back to 'pending'. Startup only: at that moment
 * nothing can be working on one, so every 'processing' row is a stranded one. The attempt the
 * claim already counted stays counted, so a row that kills the process every time still stops at
 * three rather than being retried on every boot.
 */
export function requeueStrandedExtractions() {
  return Number(db.prepare("UPDATE extraction_queue SET state = 'pending' WHERE state = 'processing'").run().changes);
}

/**
 * Claimed rows handed back untouched, their try given back: the background lane paused (a reply
 * started, the subscription hit its limit) before they were read. Nothing was wrong with them.
 */
export function releaseExtractions(ids) {
  let n = 0;
  for (const id of ids) n += Number(db.prepare("UPDATE extraction_queue SET state = 'pending', attempts = MAX(attempts - 1, 0) WHERE id = ? AND state = 'processing'").run(id).changes);
  return n;
}

export function markExtractionDone(id, { at = clock.now() } = {}) {
  db.prepare("UPDATE extraction_queue SET state = 'done', processed_at = ? WHERE id = ?").run(at, id);
}

/**
 * A failed try. One the message itself caused counts toward its three. One an outage caused does
 * not — the try is given back and the row waits a few minutes — because the message would have
 * been fine, and three tries spent in a long outage used to lose it for good.
 */
export function markExtractionFailed(id, error, { at = clock.now() } = {}) {
  const why = String(error).slice(0, 500);
  if (EXTRACTION_OUTAGE.test(why)) {
    db.prepare("UPDATE extraction_queue SET state = 'pending', last_error = ?, attempts = MAX(attempts - 1, 0), retry_at = ? WHERE id = ?")
      .run(why, at + OUTAGE_RETRY_MS, id);
    return { outage: true };
  }
  db.prepare("UPDATE extraction_queue SET state = 'pending', last_error = ? WHERE id = ?").run(why, id);
  return { outage: false };
}

/**
 * Rows that used up their tries on outage errors before tries were given back for those (or by any
 * other route), put back in line. Cheap and idempotent; run at the top of every extraction pass.
 */
export function reviveOutageExtractions({ at = clock.now() } = {}) {
  const rows = db.prepare("SELECT id, last_error FROM extraction_queue WHERE state = 'pending' AND attempts >= 3").all();
  const ids = rows.filter(r => EXTRACTION_OUTAGE.test(String(r.last_error ?? ""))).map(r => r.id);
  for (const id of ids) db.prepare("UPDATE extraction_queue SET attempts = 0, retry_at = ? WHERE id = ?").run(at, id);
  return ids.length;
}

// -- temporal fact queries --

export function activeFacts(conversationId, { personId, limit = 200 } = {}) {
  if (personId) {
    return db.prepare(
      `SELECT f.*, p.name AS about FROM person_facts f JOIN people p ON p.id = f.person_id
       WHERE p.conversation_id = ? AND f.person_id = ? AND f.status = 'active' ORDER BY f.created_at DESC, f.id DESC LIMIT ?`
    ).all(conversationId, personId, limit);
  }
  return db.prepare(
    `SELECT f.*, p.name AS about FROM person_facts f JOIN people p ON p.id = f.person_id
     WHERE p.conversation_id = ? AND f.status = 'active' ORDER BY f.created_at DESC, f.id DESC LIMIT ?`
  ).all(conversationId, limit);
}

export function supersedeFact(conversationId, oldId, newFact) {
  const old = getFact(conversationId, oldId);
  if (!old) return null;
  const now = clock.now();
  const r = db.prepare(
    `INSERT INTO person_facts (person_id, fact, created_at, valid_from, status, confidence, source, source_message_ids, category, memory_group)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
  ).run(old.person_id, sealFact(old.person_id, newFact), now, now,
    old.confidence ?? 1.0, old.source ?? "user_stated",
    old.source_message_ids ?? "[]", old.category ?? "", old.memory_group ?? "");
  const newId = Number(r.lastInsertRowid);
  db.prepare("UPDATE person_facts SET status = 'corrected', valid_to = ?, superseded_by = ? WHERE id = ?")
    .run(now, newId, oldId);
  db.prepare("UPDATE people SET updated_at = ? WHERE id = ?").run(now, old.person_id);
  return { oldId, newId, was: old.fact, now: newFact };
}

/**
 * Retire fact `oldId` because `newId` is its newer state. The extraction model's half of a change:
 * until 2026-10-19 it was asked for "the new state in full" when something moved on, and the new
 * state was saved beside the old one, so "Gmail being reconnected" and "Gmail now connected" were
 * both active and both read back as true. Only `memory_fix` ever retired anything.
 *
 * Conservative on purpose, because the model naming the wrong number would retire a true fact:
 * both rows must be active, both in this conversation, two different rows, and about the SAME
 * subject — a new fact about Kofi never retires one about Ama. Anything else is refused and both
 * rows stay, since a stale duplicate is noise and a wrongly retired fact is something Reason no
 * longer knows. Status 'superseded' rather than 'corrected': the person did not correct anything,
 * and `remember` lets only their own word revive what they corrected.
 */
export function retireForNewer(conversationId, oldId, newId) {
  const row = id => db.prepare(`SELECT f.id, f.person_id, f.fact, f.status FROM person_facts f JOIN people p ON p.id = f.person_id
    WHERE f.id = ? AND p.conversation_id = ?`).get(id, conversationId) ?? null;
  const old = row(oldId);
  const next = row(newId);
  if (!old || !next) return { ok: false, error: "not a fact in this conversation" };
  if (old.id === next.id) return { ok: false, error: "a fact cannot replace itself" };
  if (old.status !== "active" || next.status !== "active") return { ok: false, error: "not active" };
  if (old.person_id !== next.person_id) return { ok: false, error: "about a different subject" };
  const now = clock.now();
  db.prepare("UPDATE person_facts SET status = 'superseded', valid_to = ?, superseded_by = ? WHERE id = ?").run(now, newId, oldId);
  db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ? AND source_table = 'person_facts'").run(oldId);
  return { ok: true, oldId, newId, was: old.fact, now: next.fact };
}

/**
 * Active facts with no embedding, oldest first, across every conversation. A fact without one is
 * invisible to `search` and to the restatement check — see `backfillEmbeddings` in src/extract.js.
 */
export function factsMissingEmbedding({ limit = 10 } = {}) {
  return db.prepare(`SELECT f.id, f.fact, p.name AS about, p.conversation_id
    FROM person_facts f JOIN people p ON p.id = f.person_id
    WHERE f.status = 'active' AND NOT EXISTS (
      SELECT 1 FROM fact_embeddings e WHERE e.fact_id = f.id AND e.source_table = 'person_facts')
    ORDER BY f.id LIMIT ?`).all(limit);
}

// ---------- knowledge graph (Part 2) ----------

export function upsertEntity({ conversationId, type, name, aliases = [], personId = null, at = clock.now() }) {
  const k = personKey(name);
  if (!k) return null;
  const existing = db.prepare(
    "SELECT * FROM graph_entities WHERE conversation_id = ? AND type = ? AND key = ? AND status = 'active'"
  ).get(conversationId, type, k) ?? null;
  if (existing) {
    const merged = [...new Set([...JSON.parse(existing.aliases), ...aliases])];
    db.prepare("UPDATE graph_entities SET aliases = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(merged), at, existing.id);
    return { id: existing.id, canonical_name: existing.canonical_name, created: false };
  }
  const r = db.prepare(
    `INSERT INTO graph_entities (conversation_id, type, canonical_name, key, aliases, person_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(conversationId, type, name, k, JSON.stringify(aliases), personId, at, at);
  return { id: Number(r.lastInsertRowid), canonical_name: name, created: true };
}

export function getEntity(conversationId, id) {
  const row = db.prepare(
    "SELECT * FROM graph_entities WHERE id = ? AND conversation_id = ?"
  ).get(id, conversationId) ?? null;
  if (!row) return null;
  if (row.status === "merged" && row.merged_into) {
    return getEntity(conversationId, row.merged_into);
  }
  if (row.status === "deleted") return null;
  return row;
}

export function findEntity(conversationId, name, { type } = {}) {
  const k = personKey(name);
  if (!k) return null;
  if (type) {
    return db.prepare(
      "SELECT * FROM graph_entities WHERE conversation_id = ? AND type = ? AND key = ? AND status = 'active'"
    ).get(conversationId, type, k) ?? null;
  }
  return db.prepare(
    "SELECT * FROM graph_entities WHERE conversation_id = ? AND key = ? AND status = 'active'"
  ).get(conversationId, k) ?? null;
}

export function findEntitiesByText(conversationId, text) {
  const rows = db.prepare(
    "SELECT * FROM graph_entities WHERE conversation_id = ? AND status = 'active'"
  ).all(conversationId);
  const lower = text.toLowerCase();
  const matches = [];
  for (const r of rows) {
    if (lower.includes(r.key)) { matches.push(r); continue; }
    const aliases = JSON.parse(r.aliases);
    for (const a of aliases) {
      if (lower.includes(a.toLowerCase())) { matches.push(r); break; }
    }
  }
  return matches;
}

export function listEntities(conversationId, { type, limit = 100 } = {}) {
  if (type) {
    return db.prepare(
      "SELECT * FROM graph_entities WHERE conversation_id = ? AND type = ? AND status = 'active' ORDER BY updated_at DESC LIMIT ?"
    ).all(conversationId, type, limit);
  }
  return db.prepare(
    "SELECT * FROM graph_entities WHERE conversation_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT ?"
  ).all(conversationId, limit);
}

export function linkEntityPerson(entityId, personId) {
  db.prepare("UPDATE graph_entities SET person_id = ?, updated_at = ? WHERE id = ? AND person_id IS NULL")
    .run(personId, clock.now(), entityId);
}

/**
 * Once per install: fold active entities that share a name across types into one, the way
 * resolveEntity now keeps them from the start. The person node wins where there is one (it is the
 * one tied to the people table), otherwise the oldest. mergeEntities keeps the others as 'merged'
 * rows pointing at the survivor, so nothing is lost and getEntity still follows an old id.
 */
export function foldSameNameEntities() {
  if (metaGet("graph_same_name_folded")) return { already_done: true, folded: 0 };
  const groups = db.prepare(
    `SELECT conversation_id, key FROM graph_entities WHERE status = 'active'
      GROUP BY conversation_id, key HAVING COUNT(*) > 1`).all();
  let folded = 0;
  for (const g of groups) {
    const rows = db.prepare(
      `SELECT * FROM graph_entities WHERE conversation_id = ? AND key = ? AND status = 'active'
        ORDER BY (type = 'person') DESC, (person_id IS NOT NULL) DESC, id ASC`).all(g.conversation_id, g.key);
    const [keep, ...rest] = rows;
    for (const r of rest) {
      if (mergeEntities(g.conversation_id, keep.id, r.id)) folded++;
      if (r.person_id && !keep.person_id) linkEntityPerson(keep.id, r.person_id);
    }
  }
  metaSet("graph_same_name_folded", new Date(clock.now()).toISOString());
  return { folded };
}

export function mergeEntities(conversationId, keepId, mergeId) {
  const keep = getEntity(conversationId, keepId);
  const merge = getEntity(conversationId, mergeId);
  if (!keep || !merge) return null;
  const now = clock.now();
  const merged = [...new Set([...JSON.parse(keep.aliases), merge.canonical_name, ...JSON.parse(merge.aliases)])];
  db.prepare("UPDATE graph_entities SET aliases = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(merged), now, keepId);
  db.prepare("UPDATE graph_entities SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ?")
    .run(keepId, now, mergeId);
  db.prepare("UPDATE graph_edges SET src_entity = ? WHERE conversation_id = ? AND src_entity = ? AND valid_to IS NULL")
    .run(keepId, conversationId, mergeId);
  db.prepare("UPDATE graph_edges SET dst_entity = ? WHERE conversation_id = ? AND dst_entity = ? AND valid_to IS NULL")
    .run(keepId, conversationId, mergeId);
  return { keepId, mergeId };
}

export function deleteEntity(conversationId, entityId) {
  const now = clock.now();
  db.prepare("UPDATE graph_entities SET status = 'deleted', updated_at = ? WHERE id = ? AND conversation_id = ?")
    .run(now, entityId, conversationId);
  db.prepare("UPDATE graph_edges SET valid_to = ? WHERE conversation_id = ? AND (src_entity = ? OR dst_entity = ?) AND valid_to IS NULL")
    .run(now, conversationId, entityId, entityId);
}

export function entitiesForPerson(conversationId, personId) {
  return db.prepare(
    "SELECT * FROM graph_entities WHERE conversation_id = ? AND person_id = ? AND status = 'active'"
  ).all(conversationId, personId);
}

export function addEdge({ conversationId, srcEntity, relation, dstEntity, properties = {}, confidence = 1.0, source = "inferred", sourceMessageIds = [], at = clock.now() }) {
  const existing = db.prepare(
    `SELECT id FROM graph_edges WHERE conversation_id = ? AND src_entity = ? AND relation = ? AND dst_entity = ? AND valid_to IS NULL`
  ).get(conversationId, srcEntity, relation, dstEntity);
  if (existing) return { id: existing.id, created: false };
  const r = db.prepare(
    `INSERT INTO graph_edges (conversation_id, src_entity, relation, dst_entity, properties, valid_from, confidence, source, source_message_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(conversationId, srcEntity, relation, dstEntity, JSON.stringify(properties), at, confidence, source, JSON.stringify(sourceMessageIds), at);
  return { id: Number(r.lastInsertRowid), created: true };
}

export function supersedeEdge(conversationId, oldId, { relation, dstEntity, properties, confidence } = {}) {
  const old = db.prepare(
    "SELECT * FROM graph_edges WHERE id = ? AND conversation_id = ? AND valid_to IS NULL"
  ).get(oldId, conversationId);
  if (!old) return null;
  const now = clock.now();
  const r = db.prepare(
    `INSERT INTO graph_edges (conversation_id, src_entity, relation, dst_entity, properties, valid_from, confidence, source, source_message_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(conversationId, old.src_entity, relation ?? old.relation, dstEntity ?? old.dst_entity,
    JSON.stringify(properties ?? JSON.parse(old.properties)), now, confidence ?? old.confidence,
    old.source, old.source_message_ids, now);
  const newId = Number(r.lastInsertRowid);
  db.prepare("UPDATE graph_edges SET valid_to = ?, superseded_by = ? WHERE id = ?").run(now, newId, oldId);
  return { oldId, newId };
}

export function activeEdgesFrom(conversationId, entityId, { limit = 50 } = {}) {
  return db.prepare(
    `SELECT e.*, s.canonical_name AS src_name, d.canonical_name AS dst_name
     FROM graph_edges e
     JOIN graph_entities s ON s.id = e.src_entity
     JOIN graph_entities d ON d.id = e.dst_entity
     WHERE e.conversation_id = ? AND e.src_entity = ? AND e.valid_to IS NULL
     ORDER BY e.created_at DESC LIMIT ?`
  ).all(conversationId, entityId, limit);
}

export function activeEdgesTo(conversationId, entityId, { limit = 50 } = {}) {
  return db.prepare(
    `SELECT e.*, s.canonical_name AS src_name, d.canonical_name AS dst_name
     FROM graph_edges e
     JOIN graph_entities s ON s.id = e.src_entity
     JOIN graph_entities d ON d.id = e.dst_entity
     WHERE e.conversation_id = ? AND e.dst_entity = ? AND e.valid_to IS NULL
     ORDER BY e.created_at DESC LIMIT ?`
  ).all(conversationId, entityId, limit);
}

export function activeEdgesForEntities(conversationId, entityIds, { limit = 50 } = {}) {
  if (!entityIds.length) return [];
  const placeholders = entityIds.map(() => "?").join(",");
  return db.prepare(
    `SELECT e.*, s.canonical_name AS src_name, d.canonical_name AS dst_name
     FROM graph_edges e
     JOIN graph_entities s ON s.id = e.src_entity
     JOIN graph_entities d ON d.id = e.dst_entity
     WHERE e.conversation_id = ? AND (e.src_entity IN (${placeholders}) OR e.dst_entity IN (${placeholders})) AND e.valid_to IS NULL
     ORDER BY e.confidence DESC, e.created_at DESC LIMIT ?`
  ).all(conversationId, ...entityIds, ...entityIds, limit);
}

export function deleteEdgesForEntity(conversationId, entityId) {
  const now = clock.now();
  return db.prepare(
    "UPDATE graph_edges SET valid_to = ? WHERE conversation_id = ? AND (src_entity = ? OR dst_entity = ?) AND valid_to IS NULL"
  ).run(now, conversationId, entityId, entityId);
}

export function addMention({ conversationId, eventLogId, entityId, at = clock.now() }) {
  try {
    db.prepare(
      "INSERT INTO graph_mentions (conversation_id, event_log_id, entity_id, created_at) VALUES (?, ?, ?, ?)"
    ).run(conversationId, eventLogId, entityId, at);
  } catch (e) {
    if (!String(e).includes("UNIQUE")) throw e;
  }
}

export function mentionsForEntity(conversationId, entityId, { limit = 20 } = {}) {
  return db.prepare(
    "SELECT * FROM graph_mentions WHERE conversation_id = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(conversationId, entityId, limit);
}

export function addMergeCandidate({ conversationId, entityA, entityB, reason = "", at = clock.now() }) {
  const lo = Math.min(entityA, entityB), hi = Math.max(entityA, entityB);
  try {
    db.prepare(
      "INSERT INTO graph_merge_candidates (conversation_id, entity_a, entity_b, reason, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(conversationId, lo, hi, reason, at);
  } catch (e) {
    if (!String(e).includes("UNIQUE")) throw e;
  }
}

export function pendingMergeCandidates(conversationId, { limit = 10 } = {}) {
  return db.prepare(
    "SELECT * FROM graph_merge_candidates WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at LIMIT ?"
  ).all(conversationId, limit);
}

export function resolveMergeCandidate(conversationId, id, { status, at = clock.now() }) {
  db.prepare(
    "UPDATE graph_merge_candidates SET status = ?, resolved_at = ? WHERE id = ? AND conversation_id = ?"
  ).run(status, at, id, conversationId);
}

export function addGroceryItem(conversationId, { item, quantity = "", category = "", at = clock.now() }) {
  const r = db.prepare(`INSERT INTO grocery_items (conversation_id, item, quantity, category, added_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(conversationId, String(item).slice(0, 200), String(quantity).slice(0, 50),
      String(category).slice(0, 80), at);
  return getGroceryItem(Number(r.lastInsertRowid));
}

export function getGroceryItem(id) {
  return db.prepare("SELECT * FROM grocery_items WHERE id = ?").get(id) ?? null;
}

export function listGroceryItems(conversationId, { includeChecked = false } = {}) {
  return includeChecked
    ? db.prepare("SELECT * FROM grocery_items WHERE conversation_id = ? ORDER BY category, added_at").all(conversationId)
    : db.prepare("SELECT * FROM grocery_items WHERE conversation_id = ? AND checked = 0 ORDER BY category, added_at").all(conversationId);
}

export function checkGroceryItem(id, { at = clock.now() } = {}) {
  db.prepare("UPDATE grocery_items SET checked = 1, bought_at = ? WHERE id = ?").run(at, id);
  return getGroceryItem(id);
}

export function uncheckGroceryItem(id) {
  db.prepare("UPDATE grocery_items SET checked = 0, bought_at = NULL WHERE id = ?").run(id);
  return getGroceryItem(id);
}

export function removeGroceryItem(id) {
  return db.prepare("DELETE FROM grocery_items WHERE id = ?").run(id);
}

export function clearGroceryList(conversationId, { onlyChecked = false } = {}) {
  if (onlyChecked) return db.prepare("DELETE FROM grocery_items WHERE conversation_id = ? AND checked = 1").run(conversationId);
  return db.prepare("DELETE FROM grocery_items WHERE conversation_id = ?").run(conversationId);
}

/**
 * Replace the words of the last thing Reason said in a thread. Used when the outbound screen holds
 * a reply back: what was sent is what the thread has to remember, or the next turn would read a
 * line nobody ever received and carry on from it.
 */
export function replaceLastAssistant(conversationId, text) {
  const messages = loadConversation(conversationId);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    messages[i] = { role: "assistant", content: text };
    saveConversation(conversationId, messages);
    return true;
  }
  return false;
}

// ---------- the status page (src/ops.js) ----------
db.exec(`
  -- Every call Reason makes to an outside provider, counted at the one place they all pass through
  -- (watchFetch in src/ops.js): per provider per day, plus the last outcome. This is the "working ·
  -- N calls today" on the status page — a count of what really went out, never a guess.
  CREATE TABLE IF NOT EXISTS provider_calls (
    provider TEXT NOT NULL,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, day)
  );
  CREATE TABLE IF NOT EXISTS provider_state (
    provider TEXT PRIMARY KEY,
    last_ok_at INTEGER,
    last_fail_at INTEGER,
    last_status INTEGER,
    last_error TEXT NOT NULL DEFAULT '',
    last_ms INTEGER
  );
  -- Each check as last seen. A change of state is a comparison against this row, which is what
  -- makes "text the owner once per change" true across restarts rather than once per pass.
  CREATE TABLE IF NOT EXISTS ops_checks (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    since INTEGER NOT NULL,
    checked_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ops_state (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
  -- Failures raised where they happened (src/incidents.js, 2026-10-25): one row per kind of
  -- failure, so the fourteenth repeat updates the row the first one opened instead of texting again.
  CREATE TABLE IF NOT EXISTS incidents (
    key TEXT PRIMARY KEY,
    area TEXT NOT NULL,
    what TEXT NOT NULL,
    who TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    tried TEXT NOT NULL DEFAULT '',
    next TEXT NOT NULL DEFAULT '',
    covers TEXT NOT NULL DEFAULT '',
    -- The address the last failure was for, so a text to somebody else going out does not close
    -- a failure that was about this one number.
    last_addr TEXT NOT NULL DEFAULT '',
    -- Reached its threshold before there was anybody to send the text (a restart's own recovery
    -- runs before the ops wiring): sent the moment start() wires the sender.
    owed INTEGER NOT NULL DEFAULT 0,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    texted_at INTEGER,
    reminded_at INTEGER,
    resolved_at INTEGER,
    resolved_how TEXT NOT NULL DEFAULT ''
  );
  -- Operator notices held for the one daily digest (src/opsdigest.js, owner 2026-11-06): everything
  -- that is not an emergency waits here instead of landing in the owner's chat as it happens.
  CREATE TABLE IF NOT EXISTS ops_digest (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    sent_at INTEGER
  );
  -- The same calls by the hour, for the status page's 24-hour trend lines (2026-10-24). The daily
  -- table cannot say when in the day; this one is pruned to two days by opsTrends.
  CREATE TABLE IF NOT EXISTS provider_calls_hourly (
    provider TEXT NOT NULL,
    hour INTEGER NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, hour)
  );
  -- How full each Claude subscription is (src/subusage.js, 2026-10-25): numbers only — percentages,
  -- reset times, counts — never a prompt or a reply. Pruned to two days as it is written.
  CREATE TABLE IF NOT EXISTS subscription_usage (
    source TEXT NOT NULL,
    at INTEGER NOT NULL,
    five_pct REAL,
    five_resets_at INTEGER,
    week_pct REAL,
    week_resets_at INTEGER,
    status TEXT NOT NULL DEFAULT '',
    via TEXT NOT NULL DEFAULT '',
    turns_today INTEGER,
    extra TEXT
  );
  CREATE INDEX IF NOT EXISTS subscription_usage_by_source ON subscription_usage (source, at);
`);

// ---------- what each model call cost (src/spend.js) ----------
db.exec(`
  -- One row per model call Reason makes, paid API or subscription CLI, by feature (2026-10-25: the
  -- $10 on the key was gone overnight and nothing could say which feature spent it). Tokens as the
  -- response reported them; cost_usd is an estimate off config.apiPrices, and 0 on the CLI, which
  -- is the subscription and has no per-call price.
  CREATE TABLE IF NOT EXISTS model_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    feature TEXT NOT NULL,
    via TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    ok INTEGER NOT NULL DEFAULT 1,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS model_usage_day ON model_usage (day, via);
  CREATE INDEX IF NOT EXISTS model_usage_at ON model_usage (at);
`);
addColumnIfMissing("model_usage", "low_credit", "INTEGER NOT NULL DEFAULT 0");

export function recordModelUsage({ at = clock.now(), day, feature, via, model = "", ok = true, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, costUsd = 0, error = "", lowCredit = false }) {
  db.prepare(`INSERT INTO model_usage (at, day, feature, via, model, ok, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, error, low_credit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(at, day, String(feature || "other"), via, String(model ?? ""), ok ? 1 : 0, input | 0, output | 0, cacheRead | 0, cacheWrite | 0, Number(costUsd) || 0, String(error ?? "").slice(0, 200), lowCredit ? 1 : 0);
}

/** Per feature, per path, since `since` (or on `day`): calls, failures, tokens and estimated $. */
export function modelUsageBy({ since = null, day = null } = {}) {
  const where = day != null ? "day = ?" : "at >= ?";
  return db.prepare(`SELECT feature, via, COUNT(*) AS calls, SUM(1 - ok) AS failures,
      SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write,
      SUM(cost_usd) AS usd, SUM(low_credit) AS low_credit
    FROM model_usage WHERE ${where} GROUP BY feature, via ORDER BY usd DESC, calls DESC`).all(day ?? since);
}

/** Paid $ today and this month, calls (`callFeatures`) apart from everything else. `month` is "YYYY-MM". */
export function apiSpendTotals({ day, month, callFeatures = [] }) {
  const inCalls = callFeatures.length ? `feature IN (${callFeatures.map(() => "?").join(",")})` : "0";
  return db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN day = ? AND NOT ${inCalls} THEN cost_usd END), 0) AS todayOther,
      COALESCE(SUM(CASE WHEN day = ? AND ${inCalls} THEN cost_usd END), 0) AS todayCalls,
      COALESCE(SUM(cost_usd), 0) AS month
    FROM model_usage WHERE via = 'api' AND day >= ? AND day < ?`)
    .get(day, ...callFeatures, day, ...callFeatures, `${month}-01`, `${month}-99`);
}

/** Paid calls refused for want of credit since `since`. */
export function lowCreditFailures(since) {
  return db.prepare("SELECT COUNT(*) AS n, MAX(at) AS last FROM model_usage WHERE via = 'api' AND low_credit = 1 AND at >= ?").get(since);
}

/** The latest `limit` paid calls of these features, newest first: did each work, and was it credit. */
export function lastApiCalls(features, limit = 3) {
  const marks = features.map(() => "?").join(", ");
  return db.prepare(`SELECT at, feature, ok, low_credit, error FROM model_usage WHERE via = 'api' AND feature IN (${marks}) ORDER BY at DESC, id DESC LIMIT ?`).all(...features, limit);
}

/** Usage rows are counters, not a record anybody reads back: kept 35 days. */
export function pruneModelUsage(before) {
  return Number(db.prepare("DELETE FROM model_usage WHERE at < ?").run(before).changes);
}

export function recordProviderCall({ provider, day, ok, status = 0, ms = null, error = "", at = clock.now() }) {
  db.prepare(`INSERT INTO provider_calls (provider, day, calls, failures) VALUES (?, ?, 1, ?)
    ON CONFLICT(provider, day) DO UPDATE SET calls = calls + 1, failures = failures + excluded.failures`)
    .run(provider, day, ok ? 0 : 1);
  db.prepare(`INSERT INTO provider_calls_hourly (provider, hour, calls, failures) VALUES (?, ?, 1, ?)
    ON CONFLICT(provider, hour) DO UPDATE SET calls = calls + 1, failures = failures + excluded.failures`)
    .run(provider, Math.floor(at / HOUR_MS), ok ? 0 : 1);
  db.prepare(`INSERT INTO provider_state (provider, last_ok_at, last_fail_at, last_status, last_error, last_ms) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      last_ok_at = COALESCE(excluded.last_ok_at, provider_state.last_ok_at),
      last_fail_at = COALESCE(excluded.last_fail_at, provider_state.last_fail_at),
      last_status = excluded.last_status, last_error = excluded.last_error, last_ms = excluded.last_ms`)
    .run(provider, ok ? at : null, ok ? null : at, Number(status) || 0, ok ? "" : String(error ?? "").slice(0, 200), ms);
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Hourly counts for the last 24 hours, oldest first, ending with the hour `now` is in — the status
 * page's trend lines. Texts in and out are read off the messages themselves, counting people's
 * conversations only (dm:/group:, never the console or a test thread); provider calls off the
 * hourly ledger. Each series is 24 numbers. Prunes the hourly ledger past two days as it goes.
 */
export function opsTrends(now = clock.now()) {
  const end = Math.floor(now / HOUR_MS);
  const start = end - 23;
  const since = start * HOUR_MS;
  const blank = () => new Array(24).fill(0);
  const fill = (rows, key = "n") => { const a = blank(); for (const r of rows) { const i = r.h - start; if (i >= 0 && i < 24) a[i] += r[key]; } return a; };
  const PEOPLE = "(conversation_id LIKE 'dm:%' OR conversation_id LIKE 'group:%')";
  const inbound = fill(db.prepare(`SELECT CAST(received_at / ${HOUR_MS} AS INTEGER) AS h, COUNT(*) AS n FROM inbound_messages
    WHERE received_at >= ? AND ${PEOPLE} GROUP BY h`).all(since));
  const sent = fill(db.prepare(`SELECT CAST(sent_at / ${HOUR_MS} AS INTEGER) AS h, COUNT(*) AS n FROM outbox
    WHERE state = 'sent' AND sent_at >= ? AND ${PEOPLE} GROUP BY h`).all(since));
  const failed = fill(db.prepare(`SELECT CAST(failed_at / ${HOUR_MS} AS INTEGER) AS h, COUNT(*) AS n FROM outbox
    WHERE state = 'failed' AND failed_at >= ? AND ${PEOPLE} GROUP BY h`).all(since));
  db.prepare("DELETE FROM provider_calls_hourly WHERE hour < ?").run(end - 47);
  const providers = {};
  for (const r of db.prepare("SELECT provider, hour AS h, calls, failures FROM provider_calls_hourly WHERE hour >= ?").all(start)) {
    const p = (providers[r.provider] ??= { calls: blank(), failures: blank() });
    p.calls[r.h - start] += r.calls;
    p.failures[r.h - start] += r.failures;
  }
  return { start_hour: start, inbound, sent, failed, providers };
}

/**
 * Texts each person sent Reason on each of the last 7 days (24-hour buckets ending now), oldest
 * first: the little activity bar beside them on the status page.
 */
export function opsWeekByConversation(now = clock.now()) {
  const DAY_MS = 24 * HOUR_MS;
  const out = {};
  for (const r of db.prepare(`SELECT conversation_id AS c, CAST((CAST(? AS INTEGER) - received_at) / ${DAY_MS} AS INTEGER) AS ago, COUNT(*) AS n
      FROM inbound_messages WHERE received_at > ? GROUP BY c, ago`).all(now, now - 7 * DAY_MS)) {
    const i = 6 - r.ago;
    if (i < 0 || i > 6) continue;
    (out[r.c] ??= new Array(7).fill(0))[i] += r.n;
  }
  return out;
}

export function providerCalls(provider, day) {
  return db.prepare("SELECT calls, failures FROM provider_calls WHERE provider = ? AND day = ?").get(provider, day) ?? { calls: 0, failures: 0 };
}

export function providerState(provider) {
  return db.prepare("SELECT * FROM provider_state WHERE provider = ?").get(provider) ?? null;
}

/** Save one check's state. Returns what it was before (null the first time) and since when it has been what it is now. */
export function saveOpsCheck({ id, state, detail = "", at = clock.now() }) {
  const prev = db.prepare("SELECT state, since FROM ops_checks WHERE id = ?").get(id) ?? null;
  const since = prev && prev.state === state ? prev.since : at;
  db.prepare(`INSERT INTO ops_checks (id, state, detail, since, checked_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET state = excluded.state, detail = excluded.detail, since = excluded.since, checked_at = excluded.checked_at`)
    .run(id, state, String(detail ?? "").slice(0, 400), since, at);
  return { previous: prev?.state ?? null, since };
}

/**
 * Can anything reach this conversation's person? Null when it can (or might), else why not and the
 * outbox row that showed it. Read off what really happened to their last messages: an opt-out is
 * final on its own; otherwise the last UNREACHABLE_AFTER messages to them all failed for good with
 * nothing sent in between. Anything they have sent since the last failure means they are back.
 */
export const UNREACHABLE_AFTER = 3;
export function unreachable(conversationId) {
  const rows = db.prepare(
    `SELECT id, state, last_error, last_error_key, failed_at, sent_at FROM outbox
      WHERE conversation_id = ? AND to_owner = 1 AND state IN ('sent', 'failed')
      ORDER BY id DESC LIMIT ?`).all(conversationId, UNREACHABLE_AFTER);
  const last = rows[0];
  if (!last || last.state !== "failed") return null;
  const since = db.prepare("SELECT 1 FROM inbound_messages WHERE conversation_id = ? AND received_at > ? LIMIT 1")
    .get(conversationId, last.failed_at ?? 0);
  if (since) return null;
  if (last.last_error_key === "OPTED_OUT") return { why: "they've opted out of texts from this number", outboxId: last.id, optedOut: true };
  if (rows.length === UNREACHABLE_AFTER && rows.every(r => r.state === "failed")) {
    return { why: `my last ${UNREACHABLE_AFTER} messages to them all failed (${last.last_error || "no reason given"})`, outboxId: last.id };
  }
  return null;
}

export function opsGet(k) {
  return db.prepare("SELECT v FROM ops_state WHERE k = ?").get(k)?.v ?? null;
}

export function opsSet(k, v) {
  db.prepare("INSERT INTO ops_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));
}

export function opsDelete(k) {
  db.prepare("DELETE FROM ops_state WHERE k = ?").run(k);
}

// ---------- invites (src/invites.js) ----------
// Growth by invitation. Each invite is its own single-use link, `token` in the URL and `claim_code`
// in the text the invitee sends to join. Opening the link changes nothing here — the page only
// reads — and an invite is spent only by `redeemInvite`, in one transaction with the account it
// creates. `conversation_id` is the inviter's, as everywhere; `redeemed_by` is the invitee's.
//
// An install from before 2026-10 can still hold an older `invites` table — one row per invited phone
// number (address, note, invited_at, invited_by), from the first invite-by-number design that the
// access requests replaced. Nothing reads it any more. Left in place, CREATE TABLE IF NOT EXISTS
// below would keep it and every query here would fail on the live database while passing on a
// fresh one. So it is moved aside under its own name, rows and all, before the new table is made.
export const legacyInvitesMigration = (() => {
  const cols = db.prepare("PRAGMA table_info(invites)").all();
  if (!cols.length || cols.some(c => c.name === "token")) return { moved: false };
  const rows = Number(db.prepare("SELECT COUNT(*) AS n FROM invites").get().n);
  const exists = (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(n);
  let name = "invites_by_number_legacy";
  for (let i = 2; exists(name); i++) name = `invites_by_number_legacy_${i}`;
  db.exec(`ALTER TABLE invites RENAME TO ${name}`);
  return { moved: true, to: name, rows };
})();
db.exec(`
  CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    claim_code TEXT NOT NULL UNIQUE,
    -- unused | canceled | redeemed
    state TEXT NOT NULL DEFAULT 'unused',
    redeemed_by TEXT,
    created_at INTEGER NOT NULL,
    redeemed_at INTEGER,
    canceled_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS invites_owner ON invites (conversation_id, state);
  -- How many more people this person may still bring in. Lifetime, not refilling: it drops only on
  -- a successful join and rises only when the master approves a request.
  CREATE TABLE IF NOT EXISTS invite_allowances (
    conversation_id TEXT PRIMARY KEY,
    remaining INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invite_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    requested_count INTEGER NOT NULL,
    explanation TEXT NOT NULL,
    -- pending | approved | declined
    state TEXT NOT NULL DEFAULT 'pending',
    approved_count INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- At most one pending request per person, held by the database rather than by care.
  CREATE UNIQUE INDEX IF NOT EXISTS invite_requests_one_pending ON invite_requests (conversation_id) WHERE state = 'pending';
`);
// Who brought this person in, if anybody: the inviter's conversation id.
addColumnIfMissing("accounts", "invited_by", "TEXT");

/** What everybody who did not join through an invite starts with. Invitees start with none. */
export const DEFAULT_INVITES = 2;

/**
 * Give every account that has no allowance row its starting one: 0 for somebody who joined through
 * an invite, DEFAULT_INVITES for everybody else. Idempotent — an existing row is never touched, so
 * running it on every start cannot refill anybody.
 */
export function backfillInviteAllowances() {
  const now = clock.now();
  const r = db.prepare(`INSERT OR IGNORE INTO invite_allowances (conversation_id, remaining, updated_at)
    SELECT conversation_id, CASE WHEN invited_by IS NOT NULL THEN 0 ELSE ? END, ? FROM accounts`).run(DEFAULT_INVITES, now);
  return Number(r.changes);
}
export const inviteAllowanceBackfill = backfillInviteAllowances();

// Invites for ONE person while they are still dark for everybody else (owner, 2026-10-26). A row's
// `enabled` is the per-person switch; REASON_INVITES_OPEN stays the switch for all. Set only by the
// owner's scripts/grant-invites.js — no tool, page or text reaches it.
addColumnIfMissing("invite_allowances", "enabled", "INTEGER NOT NULL DEFAULT 0");

/** Has the owner turned invites on for this one person? */
export function invitesEnabledFor(conversationId) {
  const row = db.prepare("SELECT enabled FROM invite_allowances WHERE conversation_id = ?").get(conversationId);
  return !!row?.enabled;
}

/**
 * Turn invites on (with exactly `count` left) or off for one account. Off keeps the count and every
 * link as they are: links already sent still work, and turning it back on picks up where it was.
 */
export function setInvitesEnabled(conversationId, { enabled, count = null }) {
  inviteAllowance(conversationId);
  const now = clock.now();
  db.prepare("UPDATE invite_allowances SET enabled = ?, updated_at = ? WHERE conversation_id = ?").run(enabled ? 1 : 0, now, conversationId);
  if (count != null) db.prepare("UPDATE invite_allowances SET remaining = ?, updated_at = ? WHERE conversation_id = ?").run(count, now, conversationId);
  return { enabled: invitesEnabledFor(conversationId), remaining: inviteAllowance(conversationId) };
}

/** This person's remaining allowance, created on first read for an account that came later. */
export function inviteAllowance(conversationId) {
  const row = db.prepare("SELECT remaining FROM invite_allowances WHERE conversation_id = ?").get(conversationId);
  if (row) return Number(row.remaining);
  const acct = getAccount(conversationId);
  const start = acct?.invited_by ? 0 : DEFAULT_INVITES;
  db.prepare("INSERT OR IGNORE INTO invite_allowances (conversation_id, remaining, updated_at) VALUES (?, ?, ?)")
    .run(conversationId, start, clock.now());
  return Number(db.prepare("SELECT remaining FROM invite_allowances WHERE conversation_id = ?").get(conversationId).remaining);
}

/** Unused links this person is holding. Each one is a claim on one unit of the allowance. */
export function unusedInviteCount(conversationId) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM invites WHERE conversation_id = ? AND state = 'unused'").get(conversationId).n);
}

// Letters and digits nobody misreads off a phone screen: no 0/O, 1/I/L.
const CLAIM_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function newClaimCode() {
  const bytes = randomBytes(8);
  let s = "";
  for (const b of bytes) s += CLAIM_ALPHABET[b % CLAIM_ALPHABET.length];
  return s;
}
/** A link token: 24 random bytes, base64url — 32 characters, 192 bits. */
export function newInviteToken() {
  return randomBytes(24).toString("base64url");
}

/**
 * Mint one link, if this person has a unit of allowance not already held by an unused link.
 * `{ ok: true, invite }` or `{ ok: false, reason: "none_left", remaining, unused }`.
 */
export function createInvite(conversationId) {
  const remaining = inviteAllowance(conversationId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const unused = unusedInviteCount(conversationId);
    if (unused >= remaining) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "none_left", remaining, unused };
    }
    const now = clock.now();
    let id = null;
    // A collision on 192 bits is not going to happen; one on the 8-character code is merely very
    // unlikely, and UNIQUE turns it into a retry rather than two links sharing a code.
    for (let i = 0; i < 5 && id === null; i++) {
      try {
        id = Number(db.prepare("INSERT INTO invites (conversation_id, token, claim_code, state, created_at) VALUES (?, ?, ?, 'unused', ?)")
          .run(conversationId, newInviteToken(), newClaimCode(), now).lastInsertRowid);
      } catch (e) {
        if (!/UNIQUE/i.test(e?.message ?? "")) throw e;
      }
    }
    if (id === null) throw new Error("could not mint a unique invite");
    db.exec("COMMIT");
    return { ok: true, invite: getInvite(conversationId, id) };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

export function getInvite(conversationId, id) {
  return db.prepare("SELECT * FROM invites WHERE conversation_id = ? AND id = ?").get(conversationId, id) ?? null;
}

export function listInvites(conversationId) {
  return db.prepare("SELECT * FROM invites WHERE conversation_id = ? ORDER BY id").all(conversationId);
}

/** The page's lookup. Read-only, and the only way a token is ever read. */
export function inviteByToken(token) {
  return db.prepare("SELECT * FROM invites WHERE token = ?").get(String(token ?? "")) ?? null;
}

export function inviteByClaimCode(code) {
  return db.prepare("SELECT * FROM invites WHERE claim_code = ?").get(String(code ?? "").toUpperCase()) ?? null;
}

/** Cancel one of this person's own unused links. The allowance is untouched. */
export function cancelInvite(conversationId, id) {
  const r = db.prepare("UPDATE invites SET state = 'canceled', canceled_at = ? WHERE conversation_id = ? AND id = ? AND state = 'unused'")
    .run(clock.now(), conversationId, id);
  return r.changes > 0;
}

/**
 * Spend an invite on a join, all or nothing.
 *
 * One transaction: the link goes unused → redeemed (the `AND state = 'unused'` is what makes a
 * second claimer lose), the account is created under `dm:<channel>:<address>` with who invited
 * them, the inviter's allowance drops by one, and the invitee's starts at 0.
 *
 * `{ ok: true, invite, account }` or `{ ok: false, reason }` with reason one of `not_found`,
 * `redeemed`, `canceled`, `already_member`.
 */
export function redeemInvite({ claimCode, channel, address, name = "" }) {
  const conversationId = `dm:${channel}:${address}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    const inv = inviteByClaimCode(claimCode);
    const fail = (reason) => { db.exec("ROLLBACK"); return { ok: false, reason, invite: inv }; };
    if (!inv) return fail("not_found");
    if (inv.state !== "unused") return fail(inv.state);
    if (getAccount(conversationId) || accountByAddress(channel, address)) return fail("already_member");
    // Paused or removed on another line is still somebody Reason has an account for: an invite is
    // not a way back in round the master's stop (stoppedStateOf).
    if (stoppedStateOf(address)) return fail("already_member");
    const now = clock.now();
    const won = db.prepare("UPDATE invites SET state = 'redeemed', redeemed_by = ?, redeemed_at = ? WHERE id = ? AND state = 'unused'")
      .run(conversationId, now, inv.id);
    if (won.changes !== 1) return fail("redeemed");
    upsertAccount({ conversationId, channel, address, name, isOperator: false });
    db.prepare("UPDATE accounts SET invited_by = ? WHERE conversation_id = ?").run(inv.conversation_id, conversationId);
    db.prepare("UPDATE invite_allowances SET remaining = MAX(remaining - 1, 0), updated_at = ? WHERE conversation_id = ?")
      .run(now, inv.conversation_id);
    db.prepare(`INSERT INTO invite_allowances (conversation_id, remaining, updated_at) VALUES (?, 0, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET remaining = 0, updated_at = excluded.updated_at`).run(conversationId, now);
    db.exec("COMMIT");
    return { ok: true, invite: db.prepare("SELECT * FROM invites WHERE id = ?").get(inv.id), account: getAccount(conversationId) };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

/**
 * File a request for more invites, or update the one already pending. Returns the row and whether
 * it was new.
 */
export function upsertInviteRequest(conversationId, { count, explanation }) {
  const now = clock.now();
  const pending = pendingInviteRequest(conversationId);
  if (pending) {
    db.prepare("UPDATE invite_requests SET requested_count = ?, explanation = ?, updated_at = ? WHERE id = ? AND conversation_id = ?")
      .run(count, explanation, now, pending.id, conversationId);
    return { request: getInviteRequest(pending.id), updated: true };
  }
  const id = Number(db.prepare(`INSERT INTO invite_requests (conversation_id, requested_count, explanation, state, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)`).run(conversationId, count, explanation, now, now).lastInsertRowid);
  return { request: getInviteRequest(id), updated: false };
}

export function pendingInviteRequest(conversationId) {
  return db.prepare("SELECT * FROM invite_requests WHERE conversation_id = ? AND state = 'pending'").get(conversationId) ?? null;
}

export function getInviteRequest(id) {
  return db.prepare("SELECT * FROM invite_requests WHERE id = ?").get(id) ?? null;
}

/** Every pending request, oldest first. The master's list; nobody else's. */
export function pendingInviteRequests() {
  return db.prepare("SELECT * FROM invite_requests WHERE state = 'pending' ORDER BY id").all();
}

/**
 * Approve or decline one pending request. Approve adds `count` to the requester's allowance in the
 * same transaction that closes the request. Null when the request is not pending.
 */
export function decideInviteRequest(id, { approve, count = null }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const req = getInviteRequest(id);
    if (!req || req.state !== "pending") { db.exec("ROLLBACK"); return null; }
    const now = clock.now();
    const granted = approve ? Math.max(1, Number(count ?? req.requested_count)) : null;
    db.prepare("UPDATE invite_requests SET state = ?, approved_count = ?, updated_at = ? WHERE id = ? AND conversation_id = ?")
      .run(approve ? "approved" : "declined", granted, now, id, req.conversation_id);
    if (approve) {
      inviteAllowance(req.conversation_id);
      db.prepare("UPDATE invite_allowances SET remaining = remaining + ?, updated_at = ? WHERE conversation_id = ?")
        .run(granted, now, req.conversation_id);
    }
    db.exec("COMMIT");
    return getInviteRequest(id);
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

// ---------- events (src/events.js) ----------
// The first thing in Reason that belongs to more than one person. Every other table is keyed by the
// conversation it belongs to, and that key is what keeps one person's Reason out of another's. An
// event is shared on purpose — one organizer, many guests — so these rows cannot be scoped that way,
// and who may read or change what is decided in src/events.js, in code, with leakage tests
// (test/events.test.js). Nothing here checks access; nothing outside src/events.js reads these.
//
//   events            one per event. `public_id` is what a link carries (random, never the name, so
//                     two "Halloween Party"s never collide). The password is only ever a scrypt hash.
//                     `time_released` / `location_released` are separate on purpose: the time can be
//                     out while the address is still the organizer's to share.
//   event_attendees   one per guest per event. `token` is the guest's own key to the directory page:
//                     random, and dead the moment they leave or are removed (state is checked on use).
//   event_messages    every welcome, blast, update, release and cancellation, once.
//   event_deliveries  one per message per guest, carrying the outbox key that message went out under,
//                     so whether it actually reached them is read off the outbox, never assumed, and a
//                     retry can never be a second copy.
//   event_join_attempts  every password tried, right or wrong, never the password itself: the rate
//                     limit and the ops page's failed-join count.
//   event_claims      the web page's half of a join. A claim holds what the page collected and a code;
//                     the guest's own text carrying that code proves the phone and spends the claim.
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT NOT NULL UNIQUE,
    organizer_conversation_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    starts_at INTEGER,
    tz TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    welcome TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    password_version INTEGER NOT NULL DEFAULT 1,
    time_released INTEGER NOT NULL DEFAULT 0,
    location_released INTEGER NOT NULL DEFAULT 0,
    guest_list_visible INTEGER NOT NULL DEFAULT 1,
    capacity INTEGER,
    organizer_token TEXT NOT NULL UNIQUE,
    -- active | paused | cancelled
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    paused_at INTEGER,
    cancelled_at INTEGER,
    owner_told_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS events_name ON events (name_key, status);
  CREATE INDEX IF NOT EXISTS events_organizer ON events (organizer_conversation_id);
  CREATE TABLE IF NOT EXISTS event_attendees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    instagram TEXT,
    in_directory INTEGER NOT NULL DEFAULT 0,
    muted INTEGER NOT NULL DEFAULT 0,
    -- joined | left | removed
    state TEXT NOT NULL DEFAULT 'joined',
    -- text | link | web | web_text
    via TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    new_account INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (event_id, conversation_id)
  );
  CREATE INDEX IF NOT EXISTS event_attendees_person ON event_attendees (conversation_id, state);
  CREATE TABLE IF NOT EXISTS event_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    -- welcome | blast | update | release | cancel | removed
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS event_messages_event ON event_messages (event_id, id);
  CREATE TABLE IF NOT EXISTS event_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    idem_key TEXT NOT NULL,
    -- pending (not yet handed to the outbox) | handed (the outbox has it; read its rows) | error
    state TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (message_id, conversation_id)
  );
  CREATE INDEX IF NOT EXISTS event_deliveries_event ON event_deliveries (event_id, state);
  CREATE TABLE IF NOT EXISTS event_join_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER,
    actor TEXT NOT NULL,
    route TEXT NOT NULL,
    ok INTEGER NOT NULL,
    reason TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS event_join_attempts_actor ON event_join_attempts (actor, at);
  CREATE INDEX IF NOT EXISTS event_join_attempts_event ON event_join_attempts (event_id, at);
  CREATE TABLE IF NOT EXISTS event_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    code TEXT NOT NULL UNIQUE,
    password_version INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    instagram TEXT,
    in_directory INTEGER NOT NULL DEFAULT 0,
    -- open | used
    state TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT
  );
`);
// Which event brought this account in, when one did: an event join is its own way into Reason,
// separate from invites (it spends nobody's allowance and sets no invited_by).
addColumnIfMissing("accounts", "joined_via_event", "INTEGER");
// A membership's role inside its one event (spec v3 §11): `organizer` or `guest`. Organizing one
// event is never a label on the account — the same person is a guest in somebody else's. The
// organizer's own row is written when the event is made (and here, once, for events made before
// roles existed); `events.organizer_conversation_id` stays as who made it, and the two must agree
// for anybody to manage anything (src/events.js roleIn). Every guest-facing read below is
// `role = 'guest'`, so the organizer is never counted, texted, listed or given a guest's page.
addColumnIfMissing("event_attendees", "role", "TEXT NOT NULL DEFAULT 'guest'");
/** Give every event its organizer's membership row, once. Idempotent: UNIQUE (event_id, conversation_id). */
export function backfillOrganizerMemberships() {
  return Number(db.prepare(`INSERT OR IGNORE INTO event_attendees (event_id, conversation_id, display_name, in_directory, via, token, joined_at, updated_at, role)
    SELECT e.id, e.organizer_conversation_id, COALESCE((SELECT pt(name) FROM accounts WHERE conversation_id = e.organizer_conversation_id), ''), 0,
      'organizer', lower(hex(randomblob(24))), e.created_at, e.created_at, 'organizer'
    FROM events e`).run().changes);
}
backfillOrganizerMemberships();

// ---------- the guest-list note and the Instagram a person keeps (owner decision 2026-10-25) ----------
//
//   accounts.instagram           the handle they chose to share on guest lists, kept for every event
//                                after: saved when they give one (text or page), cleared by "remove
//                                my Instagram". Shown on a list only through their row on it.
//   event_attendees.list_note    the one follow-up after joining (src/events.js listNoteText): which
//                                note is owed (`ask` | `carried` | `shown`), then `sent` or `dropped`.
//                                Owed at most once per membership, so leaving and coming back does
//                                not ask again.
//   event_attendees.list_note_at while owed, when it may go (the sweep's backstop); once settled, when.
addColumnIfMissing("accounts", "instagram", "TEXT");
addColumnIfMissing("event_attendees", "list_note", "TEXT");
addColumnIfMissing("event_attendees", "list_note_at", "INTEGER");
// event_attendees.first_joined_at  when this person first joined this event. `joined_at` moves when
//                              somebody who left comes back; this never does, so "guests who joined
//                              since …" never counts a returning guest as new (owner decision 2026-11-08).
//                              Rows from before it was kept start at their `joined_at`.
addColumnIfMissing("event_attendees", "first_joined_at", "INTEGER");
db.exec("UPDATE event_attendees SET first_joined_at = joined_at WHERE first_joined_at IS NULL");
// event_attendees.list_chosen  1 once this person chose to be on the who's-going list while guests
//                              could see it, or asked to be put on it. A text join defaults to "on the
//                              list" even while the organizer keeps it private, and that default is
//                              not a choice: when the organizer later shows the list (owner request
//                              2026-11-08, events.setListVisible) only rows with this set appear, and
//                              the rest come off it and are asked once. Until then a list could never
//                              change after creation, so for older rows "on it, on a shown list" is
//                              exactly who chose it. Backfilled once, when the column is added.
{
  const had = db.prepare("PRAGMA table_info(event_attendees)").all().some(c => c.name === "list_chosen");
  addColumnIfMissing("event_attendees", "list_chosen", "INTEGER NOT NULL DEFAULT 0");
  if (!had) db.exec("UPDATE event_attendees SET list_chosen = 1 WHERE in_directory = 1 AND event_id IN (SELECT id FROM events WHERE guest_list_visible = 1)");
}
// event_claims.list_shown  whether guests could see the list when the join-page code was made. A box
//                          ticked on a private event's join page is the default, not a choice, so a
//                          code made then and used after the organizer shows the list joins OFF it.
//                          NULL for codes made before this was kept: read as the event is now.
addColumnIfMissing("event_claims", "list_shown", "INTEGER");

// ---------- guest questions (src/eventquestions.js, owner request 2026-11-08, events next-round #4) ----------
//
// event_questions  the organizer's few questions guests answer when they join ("any dietary needs?",
//                  "your plus-one's name"). `kind` text | choice; `choices` a JSON array of labels for a
//                  choice question. `version` moves on every rewording, so an answer typed on a join
//                  page against the old words is never filed under the new ones. Removing a question
//                  deletes it and its answers: nothing is kept that the organizer no longer asks.
// event_answers    one row per guest per question, theirs: `conversation_id` is the guest's, so their
//                  export carries it and their delete takes it. `choice` is the 0-based pick of a choice
//                  question (its label at the time is in `answer` too), `answer` the words. Only the
//                  organizer and the guest themselves ever read these — never another guest, never the
//                  who's-going list. `answered_at` is the first answer, `updated_at` the latest change.
// event_claims.answers  what the join page collected, as JSON, until the finishing text spends it.
db.exec(`
  CREATE TABLE IF NOT EXISTS event_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    prompt TEXT NOT NULL,
    choices TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS event_questions_event ON event_questions(event_id, position);
  CREATE TABLE IF NOT EXISTS event_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    attendee_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    choice INTEGER,
    answer TEXT NOT NULL,
    via TEXT NOT NULL,
    answered_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(question_id, attendee_id)
  );
  CREATE INDEX IF NOT EXISTS event_answers_event ON event_answers(event_id, question_id);
`);
addColumnIfMissing("event_claims", "answers", "TEXT");
// Buy for friends (src/eventpay.js, owner 2026-11-11): how many tickets the page asked for (the
// finishing text's Checkout is for that many), and — for a friend claiming a ticket somebody bought
// them — which seat, at which version of its link (a link changed since makes the claim fail).
addColumnIfMissing("event_claims", "tickets", "INTEGER");
addColumnIfMissing("event_claims", "seat_id", "INTEGER");
addColumnIfMissing("event_claims", "seat_version", "INTEGER");
// event_questions.required  1 when the organizer asks everyone this one (owner decision 2026-11-11): the
//                  join page does not go through without an answer, and a text join is not finished until
//                  it is answered. Only set while nobody has answered (an answer was given to an optional
//                  question); made optional again any time. Guests already in are never taken off for it.
addColumnIfMissing("event_questions", "required", "INTEGER NOT NULL DEFAULT 0");
// event_question_asks  the one text to a guest who was already in when a question was added, offered to
//                  the organizer after adding (owner decision 2026-11-11) and sent by the sweep (not at
//                  night, never to a muted guest). One row per guest per question, ever: `state` owed |
//                  sent | dropped; `version` the words the organizer agreed to send, so a reword first
//                  drops it. `conversation_id` is the guest's, so it goes with them.
db.exec(`
  CREATE TABLE IF NOT EXISTS event_question_asks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    attendee_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'owed',
    due_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    settled_at INTEGER,
    UNIQUE(question_id, attendee_id)
  );
  CREATE INDEX IF NOT EXISTS event_question_asks_due ON event_question_asks(state, due_at);
`);

/** An event's questions, in the order guests see them. */
export function eventQuestions(eventId) {
  return db.prepare("SELECT * FROM event_questions WHERE event_id = ? ORDER BY position, id").all(Number(eventId));
}
export function eventQuestion(eventId, id) {
  return db.prepare("SELECT * FROM event_questions WHERE event_id = ? AND id = ?").get(Number(eventId), Number(id)) ?? null;
}
export function insertEventQuestion({ eventId, kind, prompt, choices = null, required = false }) {
  const now = clock.now();
  const pos = db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM event_questions WHERE event_id = ?").get(Number(eventId)).p;
  const id = Number(db.prepare("INSERT INTO event_questions (event_id, position, kind, prompt, choices, required, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
    .run(Number(eventId), pos, kind, prompt, choices ? JSON.stringify(choices) : null, required ? 1 : 0, now, now).lastInsertRowid);
  return eventQuestion(eventId, id);
}
/** Reword a question nobody has answered yet; compare-and-set on there still being no answer. */
export function rewordEventQuestion({ eventId, id, kind, prompt, choices = null, required = false }) {
  const r = db.prepare(`UPDATE event_questions SET kind = ?, prompt = ?, choices = ?, required = ?, version = version + 1, updated_at = ?
    WHERE event_id = ? AND id = ? AND NOT EXISTS (SELECT 1 FROM event_answers WHERE question_id = event_questions.id)`)
    .run(kind, prompt, choices ? JSON.stringify(choices) : null, required ? 1 : 0, clock.now(), Number(eventId), Number(id));
  return r.changes === 1 ? eventQuestion(eventId, id) : null;
}
/**
 * Only whether everyone has to answer it, the words untouched (so `version` stays, and answers given
 * stand). Making it required is compare-and-set on there being no answer; making it optional always goes.
 */
export function setEventQuestionRequired(eventId, id, required) {
  const r = required
    ? db.prepare("UPDATE event_questions SET required = 1, updated_at = ? WHERE event_id = ? AND id = ? AND NOT EXISTS (SELECT 1 FROM event_answers WHERE question_id = event_questions.id)").run(clock.now(), Number(eventId), Number(id))
    : db.prepare("UPDATE event_questions SET required = 0, updated_at = ? WHERE event_id = ? AND id = ?").run(clock.now(), Number(eventId), Number(id));
  return r.changes === 1 ? eventQuestion(eventId, id) : null;
}
/** A question and every answer to it, in one go. How many answers went with it. */
export function deleteEventQuestion(eventId, id) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM event_question_asks WHERE event_id = ? AND question_id = ?").run(Number(eventId), Number(id));
    const gone = db.prepare("DELETE FROM event_answers WHERE event_id = ? AND question_id = ?").run(Number(eventId), Number(id)).changes;
    const q = db.prepare("DELETE FROM event_questions WHERE event_id = ? AND id = ?").run(Number(eventId), Number(id)).changes;
    db.exec("COMMIT");
    return q === 1 ? { ok: true, answers: gone } : { ok: false };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}
/** Every answer on an event, with whose it is: the organizer's read (src/eventquestions.js decides who sees it). */
export function eventAnswers(eventId) {
  return db.prepare(`SELECT ans.*, a.display_name, a.state FROM event_answers ans JOIN event_attendees a ON a.id = ans.attendee_id
    WHERE ans.event_id = ? ORDER BY ans.question_id, ans.answered_at, ans.id`).all(Number(eventId));
}
/** One guest's own answers on one event. */
export function answersOf(eventId, attendeeId) {
  return db.prepare("SELECT * FROM event_answers WHERE event_id = ? AND attendee_id = ? ORDER BY question_id").all(Number(eventId), Number(attendeeId));
}
/** Set (or change) one guest's answer to one question; the first answer's time is kept. */
export function setEventAnswer({ eventId, questionId, attendeeId, conversationId, choice = null, answer, via }) {
  const now = clock.now();
  db.prepare(`INSERT INTO event_answers (event_id, question_id, attendee_id, conversation_id, choice, answer, via, answered_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(question_id, attendee_id) DO UPDATE SET choice = excluded.choice, answer = excluded.answer, via = excluded.via, updated_at = excluded.updated_at`)
    .run(Number(eventId), Number(questionId), Number(attendeeId), conversationId, choice, answer, via, now, now);
}
export function clearEventAnswer(questionId, attendeeId) {
  return db.prepare("DELETE FROM event_answers WHERE question_id = ? AND attendee_id = ?").run(Number(questionId), Number(attendeeId)).changes === 1;
}
export function questionAnswerCount(questionId) {
  return db.prepare("SELECT COUNT(*) AS n FROM event_answers WHERE question_id = ?").get(Number(questionId)).n;
}

// ---- the one "the organizer added a question" text to guests already in (src/events.js questionAsk*) ----

/** Every ask ever made on this question, whatever became of it: a guest on it is never asked again. */
export function questionAskRows(questionId) {
  return db.prepare("SELECT * FROM event_question_asks WHERE question_id = ?").all(Number(questionId));
}
/** Owe the text to each of these guests, once ever per guest per question (a row already there stands). How many are newly owed. */
export function oweQuestionAsks(eventId, question, attendees, dueAt) {
  const ins = db.prepare(`INSERT OR IGNORE INTO event_question_asks (event_id, question_id, attendee_id, conversation_id, version, state, due_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'owed', ?, ?)`);
  let n = 0;
  for (const a of attendees) n += ins.run(Number(eventId), Number(question.id), Number(a.id), a.conversation_id, Number(question.version), dueAt, clock.now()).changes;
  return n;
}
/** Owed asks that are due, on events that can still send. */
export function owedQuestionAsks(now = clock.now(), { limit = 200 } = {}) {
  return db.prepare(`SELECT k.* FROM event_question_asks k JOIN events e ON e.id = k.event_id AND e.status != 'paused'
    WHERE k.state = 'owed' AND k.due_at <= ? ORDER BY k.due_at, k.id LIMIT ?`).all(now, limit);
}
export function questionAsk(id) {
  return db.prepare("SELECT * FROM event_question_asks WHERE id = ?").get(Number(id)) ?? null;
}
/** Settle an owed ask, compare-and-set on it still being owed: the one caller that wins sends it. */
export function settleQuestionAsk(id, outcome) {
  return db.prepare("UPDATE event_question_asks SET state = ?, settled_at = ? WHERE id = ? AND state = 'owed'").run(outcome, clock.now(), Number(id)).changes === 1;
}

export function setAccountInstagram(conversationId, handle) {
  db.prepare("UPDATE accounts SET instagram = ? WHERE conversation_id = ?").run(handle ?? null, conversationId);
}
/** Take their handle off every list they are on (their own rows only), for "remove my Instagram". */
export function clearInstagramEverywhere(conversationId) {
  return Number(db.prepare("UPDATE event_attendees SET instagram = NULL, updated_at = ? WHERE conversation_id = ? AND instagram IS NOT NULL").run(clock.now(), conversationId).changes);
}
/** A new handle on every list where they show one now. */
export function replaceInstagramEverywhere(conversationId, handle) {
  return Number(db.prepare("UPDATE event_attendees SET instagram = ?, updated_at = ? WHERE conversation_id = ? AND instagram IS NOT NULL").run(handle, clock.now(), conversationId).changes);
}
/**
 * Owe the note, once per membership: once it went (or was dropped) it is never owed again. One still
 * owed — they left and came back before it went — is owed afresh, as things now stand.
 */
export function oweListNote(attendeeId, kind, dueAt) {
  return db.prepare("UPDATE event_attendees SET list_note = ?, list_note_at = ? WHERE id = ? AND (list_note IS NULL OR list_note IN ('ask', 'carried', 'shown', 'opened', 'opened_dropped'))").run(kind, dueAt, Number(attendeeId)).changes === 1;
}
/**
 * The guests showing the list would take off it and ask: joined, on it only by default, never chose
 * it — and those taken off by an earlier show whose ask was dropped before it went (the list went
 * private again first), so a show after that still asks them once.
 */
export function unchosenListed(eventId) {
  return db.prepare("SELECT * FROM event_attendees WHERE event_id = ? AND role = 'guest' AND state = 'joined' AND list_chosen = 0 AND (in_directory = 1 OR list_note = 'opened_dropped') ORDER BY id").all(Number(eventId));
}
/**
 * The organizer just showed a list these guests joined while it was private: each comes off it, and
 * the one "want to be on it?" note is owed (`opened`) — unless they muted the event or a note
 * already went to them on it. Call inside the caller's transaction. Returns how many were taken off and how many are owed.
 */
export function openListFor(eventId, dueAt) {
  const rows = unchosenListed(eventId);
  let owed = 0;
  for (const r of rows) {
    db.prepare("UPDATE event_attendees SET in_directory = 0, updated_at = ? WHERE id = ?").run(clock.now(), r.id);
    // Never to a guest who muted the event, and never a second note on the same event.
    if (!r.muted && r.list_note !== "sent") {
      db.prepare("UPDATE event_attendees SET list_note = 'opened', list_note_at = ? WHERE id = ?").run(dueAt, r.id);
      owed++;
    }
  }
  return { off: rows.length, owed };
}
/** Settle an owed note, compare-and-set on it still being owed: the one caller that wins sends it. */
export function settleListNote(attendeeId, kind, outcome) {
  return db.prepare("UPDATE event_attendees SET list_note = ?, list_note_at = ? WHERE id = ? AND list_note = ?").run(outcome, clock.now(), Number(attendeeId), kind).changes === 1;
}
/** Owed notes that are due, on events that can still send: a paused event's wait off the queue. */
export function owedListNotes(now = clock.now(), { limit = 200 } = {}) {
  return db.prepare(`SELECT a.* FROM event_attendees a JOIN events e ON e.id = a.event_id AND e.status != 'paused'
    WHERE a.list_note IN ('ask', 'carried', 'shown', 'opened') AND a.list_note_at <= ? AND a.state = 'joined'
    ORDER BY a.list_note_at, a.id LIMIT ?`).all(now, limit);
}
/** The organizer's own row when they are on their own list: listed, but never counted or texted as a guest. */
export function organizerListing(eventId) {
  return db.prepare("SELECT * FROM event_attendees WHERE event_id = ? AND role = 'organizer' AND state = 'joined' AND in_directory = 1 AND display_name != ''").get(Number(eventId)) ?? null;
}

// ---------- rides between an event's guests (src/rides.js, spec v3 §13) ----------
//
//   events.rides_enabled  the organizer's switch, per event; off unless they turn it on.
//   ride_offers           one per guest per event at most while live: offering seats or needing a
//                         ride, from a general area (a neighborhood, never an address) at a rough
//                         time, one way or round trip. `area_lat/lng` is where that area geocoded
//                         to, for "same general area"; null when it would not.
//   ride_matches          one suggested pairing of a driver's offer and a rider's need, and each
//                         side's answer. Nothing is committed until both said yes (`agreed`).
//   ride_asks             the one day-before "are you driving or looking for a ride?" per guest.
//   ride_blocks           a pair somebody reported: never suggested to each other again.
addColumnIfMissing("events", "rides_enabled", "INTEGER NOT NULL DEFAULT 0");
// Paid events (src/eventpay.js): the price per person in cents, null for a free event. Every join of
// a priced event goes through a Checkout Session and lands from the webhook (eventpay.settlePaid).
addColumnIfMissing("events", "price_cents", "INTEGER");
addColumnIfMissing("events", "currency", "TEXT NOT NULL DEFAULT 'usd'");
// The refund policy on a priced event (src/eventpay.js refundWindow): 'none' | 'until' | 'anytime',
// null = the default ('until', 48 hours before it starts); `refund_hours` is the N of 'until'.
addColumnIfMissing("events", "refund_policy", "TEXT");
addColumnIfMissing("events", "refund_hours", "INTEGER");
// Tickets one buyer may get at once on a priced event (src/eventpay.js ticketMax): null = the default
// (4), 1 = no extra tickets for friends.
addColumnIfMissing("events", "ticket_max", "INTEGER");
// The link preview card (spec §14, src/eventcover.js). The live cover is an uploaded picture the
// organizer approved after seeing the card it makes (`cover_file`, under data/event-covers, with who
// approved it and when); with none, the card is Reason's own drawing of the name. `cover_pending` is
// a picture waiting on the organizer — never shown to anybody else. `time_public` / `location_public`
// are "anyone with the link may see this", a separate and deliberate choice from releasing a detail
// to joined guests; `public_ask` is the question that choice has to be answered to.
addColumnIfMissing("events", "cover_file", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("events", "cover_version", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("events", "cover_approved_at", "INTEGER");
addColumnIfMissing("events", "cover_approved_by", "TEXT");
addColumnIfMissing("events", "cover_media_id", "INTEGER");
addColumnIfMissing("events", "cover_findings", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("events", "cover_pending", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("events", "time_public", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("events", "location_public", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("events", "public_ask", "TEXT NOT NULL DEFAULT ''");
db.exec(`
  CREATE TABLE IF NOT EXISTS ride_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    -- offer (has seats) | need (wants a ride)
    kind TEXT NOT NULL,
    area TEXT NOT NULL,
    area_lat REAL,
    area_lng REAL,
    leave_at INTEGER NOT NULL,
    seats INTEGER NOT NULL DEFAULT 1,
    round_trip INTEGER NOT NULL DEFAULT 0,
    -- open | matched | cancelled
    status TEXT NOT NULL DEFAULT 'open',
    matched_conversation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ride_offers_event ON ride_offers (event_id, status);
  CREATE INDEX IF NOT EXISTS ride_offers_person ON ride_offers (conversation_id, status);
  CREATE TABLE IF NOT EXISTS ride_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    driver_offer_id INTEGER NOT NULL,
    rider_offer_id INTEGER NOT NULL,
    driver_answer TEXT,
    rider_answer TEXT,
    -- pending | agreed | declined | cancelled | expired
    state TEXT NOT NULL DEFAULT 'pending',
    pickup_area TEXT,
    window_start INTEGER,
    window_end INTEGER,
    -- how they coordinate once agreed: null (not chosen) | reason | intro; intro needs both consents
    driver_contact TEXT,
    rider_contact TEXT,
    reminded_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ride_matches_event ON ride_matches (event_id, state);
  CREATE TABLE IF NOT EXISTS ride_asks (
    event_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    asked_at INTEGER NOT NULL,
    -- what they said back, once they did: offer | need | neither
    answer TEXT,
    PRIMARY KEY (event_id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS ride_blocks (
    event_id INTEGER NOT NULL,
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    reported_by TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (event_id, a, b)
  );
`);

const RIDE_FIELDS = new Set(["area", "area_lat", "area_lng", "leave_at", "seats", "round_trip", "status", "matched_conversation_id"]);
export function insertRideOffer(r) {
  const now = clock.now();
  const id = Number(db.prepare(`INSERT INTO ride_offers (event_id, conversation_id, kind, area, area_lat, area_lng, leave_at, seats, round_trip, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(Number(r.eventId), r.conversationId, r.kind, r.area, r.lat ?? null, r.lng ?? null, r.leaveAt, r.seats, r.roundTrip ? 1 : 0, now, now).lastInsertRowid);
  return rideOffer(id);
}
export function rideOffer(id) {
  return db.prepare("SELECT * FROM ride_offers WHERE id = ?").get(Number(id)) ?? null;
}
export function updateRideOffer(id, fields) {
  const keys = Object.keys(fields).filter(k => RIDE_FIELDS.has(k));
  if (keys.length) db.prepare(`UPDATE ride_offers SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map(k => fields[k]), clock.now(), Number(id));
  return rideOffer(id);
}
/** This person's live offer or need for this event (open or matched), if they have one. */
export function liveRideOffer(eventId, conversationId) {
  return db.prepare("SELECT * FROM ride_offers WHERE event_id = ? AND conversation_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1").get(Number(eventId), conversationId) ?? null;
}
export function rideOffersFor(eventId, { status = null } = {}) {
  return status
    ? db.prepare("SELECT * FROM ride_offers WHERE event_id = ? AND status = ? ORDER BY id").all(Number(eventId), status)
    : db.prepare("SELECT * FROM ride_offers WHERE event_id = ? ORDER BY id").all(Number(eventId));
}
export function rideOffersOfPerson(conversationId) {
  return db.prepare("SELECT * FROM ride_offers WHERE conversation_id = ? AND status != 'cancelled' ORDER BY id DESC").all(conversationId);
}

export function insertRideMatch({ eventId, driverOfferId, riderOfferId }) {
  const now = clock.now();
  const id = Number(db.prepare(`INSERT INTO ride_matches (event_id, driver_offer_id, rider_offer_id, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`)
    .run(Number(eventId), Number(driverOfferId), Number(riderOfferId), now, now).lastInsertRowid);
  return rideMatch(id);
}
export function rideMatch(id) {
  return db.prepare("SELECT * FROM ride_matches WHERE id = ?").get(Number(id)) ?? null;
}
const MATCH_FIELDS = new Set(["driver_answer", "rider_answer", "state", "pickup_area", "window_start", "window_end", "driver_contact", "rider_contact", "reminded_at"]);
export function updateRideMatch(id, fields, { fromState = null } = {}) {
  const keys = Object.keys(fields).filter(k => MATCH_FIELDS.has(k));
  if (!keys.length) return rideMatch(id);
  const r = db.prepare(`UPDATE ride_matches SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?${fromState ? " AND state = ?" : ""}`)
    .run(...keys.map(k => fields[k]), clock.now(), Number(id), ...(fromState ? [fromState] : []));
  return r.changes === 1 ? rideMatch(id) : null;
}
/** Matches one offer is in, newest first, optionally only in some states. */
export function rideMatchesForOffer(offerId, states = null) {
  const rows = db.prepare("SELECT * FROM ride_matches WHERE driver_offer_id = ? OR rider_offer_id = ? ORDER BY id DESC").all(Number(offerId), Number(offerId));
  return states ? rows.filter(m => states.includes(m.state)) : rows;
}
export function rideMatchesFor(eventId, states = null) {
  const rows = db.prepare("SELECT * FROM ride_matches WHERE event_id = ? ORDER BY id").all(Number(eventId));
  return states ? rows.filter(m => states.includes(m.state)) : rows;
}
/**
 * Were these two PEOPLE already suggested to each other on this event and it came to nothing — a no
 * or a suggestion left to lapse? Then never again, whatever offers either of them makes next. (A
 * pairing ended because one of them changed plans is not that: they may fit again.)
 */
export function ridePeopleSpent(eventId, x, y) {
  return !!db.prepare(`SELECT 1 FROM ride_matches m JOIN ride_offers d ON d.id = m.driver_offer_id JOIN ride_offers r ON r.id = m.rider_offer_id
    WHERE m.event_id = ? AND m.state IN ('declined', 'expired')
      AND ((d.conversation_id = ? AND r.conversation_id = ?) OR (d.conversation_id = ? AND r.conversation_id = ?)) LIMIT 1`)
    .get(Number(eventId), x, y, y, x);
}

export function noteRideAsk(eventId, conversationId) {
  return db.prepare("INSERT OR IGNORE INTO ride_asks (event_id, conversation_id, asked_at) VALUES (?, ?, ?)").run(Number(eventId), conversationId, clock.now()).changes === 1;
}
export function rideAsk(eventId, conversationId) {
  return db.prepare("SELECT * FROM ride_asks WHERE event_id = ? AND conversation_id = ?").get(Number(eventId), conversationId) ?? null;
}
export function answerRideAsk(eventId, conversationId, answer) {
  db.prepare(`INSERT INTO ride_asks (event_id, conversation_id, asked_at, answer) VALUES (?, ?, ?, ?)
    ON CONFLICT(event_id, conversation_id) DO UPDATE SET answer = excluded.answer`).run(Number(eventId), conversationId, clock.now(), answer);
}

const pair = (x, y) => (x < y ? [x, y] : [y, x]);
export function blockRidePair(eventId, x, y, reportedBy) {
  const [a, b] = pair(x, y);
  db.prepare("INSERT OR IGNORE INTO ride_blocks (event_id, a, b, reported_by, at) VALUES (?, ?, ?, ?, ?)").run(Number(eventId), a, b, reportedBy, clock.now());
}
export function ridePairBlocked(eventId, x, y) {
  const [a, b] = pair(x, y);
  return !!db.prepare("SELECT 1 FROM ride_blocks WHERE event_id = ? AND a = ? AND b = ?").get(Number(eventId), a, b);
}
/** Live events with rides on, for the sweep. */
export function eventsWithRides() {
  return db.prepare("SELECT * FROM events WHERE rides_enabled = 1 AND status = 'active' ORDER BY id").all();
}

// ---------- messages the organizer scheduled, and the automatic reminders (src/eventschedule.js) ----------
//
//   events.remind_day_before / remind_soon   the organizer's two reminder switches. 0 for every event
//                     made before reminders existed (nobody's guests start getting texts their
//                     organizer was never told about); insertEvent writes 1 for every new event.
//   event_scheduled   one per scheduled message (`kind` message: the organizer's words, sent at
//                     `send_at`) and one per reminder that went (`kind` reminder_day | reminder_soon,
//                     written when it is claimed, for the start time it was about). A row is claimed
//                     (pending → sending) and its event message made in one transaction, so two passes
//                     can never both send it, and a process that died mid-send finds it still
//                     `sending`, with its message, and finishes it: deliveries are one per guest per
//                     message (event_deliveries), so finishing never sends anybody a second copy.
//                     UNIQUE (event_id, kind, for_starts_at) makes a reminder once per start time;
//                     messages leave for_starts_at NULL, and NULLs never collide.
addColumnIfMissing("events", "remind_day_before", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("events", "remind_soon", "INTEGER NOT NULL DEFAULT 0");
db.exec(`
  CREATE TABLE IF NOT EXISTS event_scheduled (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    -- message | reminder_day | reminder_soon
    kind TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    send_at INTEGER NOT NULL,
    for_starts_at INTEGER,
    -- pending | sending | sent | cancelled | missed
    state TEXT NOT NULL DEFAULT 'pending',
    message_id INTEGER,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sent_at INTEGER,
    UNIQUE (event_id, kind, for_starts_at)
  );
  CREATE INDEX IF NOT EXISTS event_scheduled_due ON event_scheduled (state, send_at);
  CREATE INDEX IF NOT EXISTS event_scheduled_event ON event_scheduled (event_id, state);
`);

// Messages to only some guests (owner request 2026-11-08, src/events.js `recipients`):
//
//   event_messages.audience / event_scheduled.audience   who a message is for, as the canonical
//                     JSON src/events.js `audienceKey` writes — {"guests":[attendee ids]} or
//                     {"joined_since":ms}. NULL is every guest, as before. Carried from the scheduled
//                     row onto the message it goes out as, so a message finished after a restart
//                     still reaches exactly the guests it was set for.
addColumnIfMissing("event_messages", "audience", "TEXT");
addColumnIfMissing("event_scheduled", "audience", "TEXT");

export function insertScheduledMessage({ eventId, conversationId, body, sendAt, audience = null }) {
  const now = clock.now();
  const id = Number(db.prepare(`INSERT INTO event_scheduled (event_id, conversation_id, kind, body, send_at, state, created_at, updated_at, audience)
    VALUES (?, ?, 'message', ?, ?, 'pending', ?, ?, ?)`).run(Number(eventId), conversationId, String(body), Number(sendAt), now, now, audience ?? null).lastInsertRowid);
  return scheduledRow(id);
}
export function scheduledRow(id) {
  return db.prepare("SELECT * FROM event_scheduled WHERE id = ?").get(Number(id)) ?? null;
}
/** One event's rows, soonest first, optionally only in some states. */
export function scheduledFor(eventId, states = null) {
  const rows = db.prepare("SELECT * FROM event_scheduled WHERE event_id = ? ORDER BY send_at, id").all(Number(eventId));
  return states ? rows.filter(r => states.includes(r.state)) : rows;
}
/** New words and a new time for a message still waiting, compare-and-set on it still waiting. */
export function updatePendingScheduled(id, { body, sendAt, audience = null }) {
  return db.prepare("UPDATE event_scheduled SET body = ?, send_at = ?, audience = ?, updated_at = ? WHERE id = ? AND state = 'pending' AND kind = 'message'")
    .run(String(body), Number(sendAt), audience ?? null, clock.now(), Number(id)).changes === 1;
}
/** Settle a row that has not started sending: cancelled or missed, with why. */
export function settlePendingScheduled(id, state, note = null) {
  return db.prepare("UPDATE event_scheduled SET state = ?, note = ?, updated_at = ? WHERE id = ? AND state = 'pending'")
    .run(state, note, clock.now(), Number(id)).changes === 1;
}
/** Every message still waiting on one event, cancelled at once (the event itself was cancelled). */
export function cancelPendingScheduledFor(eventId, note) {
  return Number(db.prepare("UPDATE event_scheduled SET state = 'cancelled', note = ?, updated_at = ? WHERE event_id = ? AND state = 'pending'")
    .run(note, clock.now(), Number(eventId)).changes);
}
/** Messages whose time has come, and rows a stopped process left mid-send. */
export function dueScheduled(now = clock.now(), { limit = 200 } = {}) {
  // A row left sending on an event the operator paused waits for the resume; listing it every pass
  // would let a pile of them crowd out messages that are due now.
  return db.prepare(`SELECT * FROM event_scheduled WHERE (state = 'pending' AND send_at <= ?)
    OR (state = 'sending' AND event_id NOT IN (SELECT id FROM events WHERE status = 'paused')) ORDER BY send_at, id LIMIT ?`).all(now, limit);
}
/**
 * Claim one waiting message and make the event message it goes out as, together: pending → sending
 * and the message row, or neither. `makeBody(row)` is called inside, after the claim. Returns the
 * claimed row, or null when it was no longer waiting (claimed by another pass, or cancelled).
 */
export function claimScheduledMessage(id, makeBody, messageKind) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = scheduledRow(id);
    const ok = !!row && db.prepare("UPDATE event_scheduled SET state = 'sending', updated_at = ? WHERE id = ? AND state = 'pending'").run(clock.now(), Number(id)).changes === 1;
    if (!ok) { db.exec("ROLLBACK"); return null; }
    const message = insertEventMessage(row.event_id, messageKind, makeBody(row), row.audience ?? null);
    db.prepare("UPDATE event_scheduled SET message_id = ? WHERE id = ?").run(message.id, Number(id));
    db.exec("COMMIT");
    return scheduledRow(id);
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}
/**
 * Claim one reminder for one start time and make its event message, together. Null when it was
 * already claimed for that start time — by this pass, an earlier one, or a process that died.
 */
export function claimReminder({ eventId, conversationId, kind, sendAt, forStartsAt, body, messageKind }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const now = clock.now();
    const r = db.prepare(`INSERT OR IGNORE INTO event_scheduled (event_id, conversation_id, kind, body, send_at, for_starts_at, state, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, ?, 'sending', ?, ?)`).run(Number(eventId), conversationId, kind, Number(sendAt), Number(forStartsAt), now, now);
    if (Number(r.changes) !== 1) { db.exec("ROLLBACK"); return null; }
    const id = Number(r.lastInsertRowid);
    const message = insertEventMessage(eventId, messageKind, body);
    db.prepare("UPDATE event_scheduled SET message_id = ? WHERE id = ?").run(message.id, id);
    db.exec("COMMIT");
    return scheduledRow(id);
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}
/** The reminder of this kind already claimed for this start time, if one was. */
export function reminderRow(eventId, kind, forStartsAt) {
  return db.prepare("SELECT * FROM event_scheduled WHERE event_id = ? AND kind = ? AND for_starts_at = ?").get(Number(eventId), kind, Number(forStartsAt)) ?? null;
}
/** A row that was sending is done: sent, or (the event was cancelled under it) cancelled. */
export function finishScheduled(id, state = "sent", note = null) {
  const now = clock.now();
  return db.prepare("UPDATE event_scheduled SET state = ?, note = ?, sent_at = ?, updated_at = ? WHERE id = ? AND state = 'sending'")
    .run(state, note, now, now, Number(id)).changes === 1;
}
/** Live events with a reminder switched on and a start time: the reminder pass's list. */
export function eventsWithReminders() {
  return db.prepare("SELECT * FROM events WHERE (remind_day_before = 1 OR remind_soon = 1) AND status = 'active' AND starts_at IS NOT NULL ORDER BY id").all();
}

/** A random key for a link or a page: 24 bytes, base64url, 32 characters. */
export function newEventToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

export function insertEvent(row) {
  const now = clock.now();
  for (let i = 0; i < 5; i++) {
    try {
      const id = Number(db.prepare(`INSERT INTO events (public_id, organizer_conversation_id, name, name_key, description, starts_at, tz,
        location, welcome, password_hash, time_released, location_released, guest_list_visible, capacity, organizer_token, status, created_at, updated_at,
        remind_day_before, remind_soon)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).run(
        newEventToken(12), row.organizer, row.name, row.nameKey, row.description, row.startsAt, row.tz,
        row.location, row.welcome, row.passwordHash, row.timeReleased ? 1 : 0, row.locationReleased ? 1 : 0,
        row.guestListVisible ? 1 : 0, row.capacity ?? null, newEventToken(), now, now,
        // Both reminders are on for every event made from here on; events made before reminders
        // existed keep the column's 0 until their organizer turns one on (src/eventschedule.js).
        row.remindDayBefore === false ? 0 : 1, row.remindSoon === false ? 0 : 1).lastInsertRowid);
      addOrganizerMembership(id, row.organizer, row.organizerName ?? "");
      return getEventRow(id);
    } catch (e) {
      if (!/UNIQUE/i.test(e?.message ?? "")) throw e;
    }
  }
  throw new Error("could not mint a unique event id");
}

/** The organizer's own membership of their event: role organizer, never listed, never texted as a guest. */
function addOrganizerMembership(eventId, conversationId, displayName) {
  const now = clock.now();
  db.prepare(`INSERT OR IGNORE INTO event_attendees (event_id, conversation_id, display_name, in_directory, via, token, joined_at, updated_at, role)
    VALUES (?, ?, ?, 0, 'organizer', ?, ?, ?, 'organizer')`).run(Number(eventId), conversationId, String(displayName ?? ""), newEventToken(32), now, now);
}

/** Every live membership one person holds, with its event and its role: the input to "which event?". */
export function membershipsOf(conversationId) {
  return db.prepare(`SELECT e.*, a.id AS attendee_id, a.role AS role FROM event_attendees a JOIN events e ON e.id = a.event_id
    WHERE a.conversation_id = ? AND a.state = 'joined' ORDER BY e.id DESC`).all(conversationId);
}

export function getEventRow(id) {
  return db.prepare("SELECT * FROM events WHERE id = ?").get(Number(id)) ?? null;
}
export function eventByPublicId(publicId) {
  return db.prepare("SELECT * FROM events WHERE public_id = ?").get(String(publicId ?? "")) ?? null;
}
export function eventByOrganizerToken(token) {
  return db.prepare("SELECT * FROM events WHERE organizer_token = ?").get(String(token ?? "")) ?? null;
}
/** Live events whose name matches: exactly first, then either name containing the other. */
export function eventsNamed(nameKey, { limit = 25 } = {}) {
  const key = String(nameKey ?? "");
  if (!key) return [];
  const exact = db.prepare("SELECT * FROM events WHERE name_key = ? AND status != 'cancelled' ORDER BY id DESC LIMIT ?").all(key, limit);
  if (exact.length) return exact;
  return db.prepare(`SELECT * FROM events WHERE status != 'cancelled' AND length(?) >= 3
    AND (instr(name_key, ?) > 0 OR instr(?, name_key) > 0) ORDER BY id DESC LIMIT ?`).all(key, key, key, limit);
}
export function eventsOrganizedBy(conversationId) {
  return db.prepare(`SELECT e.* FROM events e JOIN event_attendees a ON a.event_id = e.id AND a.conversation_id = e.organizer_conversation_id
    WHERE e.organizer_conversation_id = ? AND a.role = 'organizer' ORDER BY e.id DESC`).all(conversationId);
}
export function eventsAttendedBy(conversationId) {
  return db.prepare(`SELECT e.*, a.id AS attendee_id FROM event_attendees a JOIN events e ON e.id = a.event_id
    WHERE a.conversation_id = ? AND a.state = 'joined' AND a.role = 'guest' ORDER BY e.id DESC`).all(conversationId);
}
export function allEvents({ limit = 50 } = {}) {
  return db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
}

/** Change an event's own fields. Only the columns named; the caller has already checked who may. */
const EVENT_FIELDS = new Set(["name", "name_key", "description", "starts_at", "tz", "location", "welcome", "password_hash", "password_version",
  "time_released", "location_released", "guest_list_visible", "capacity", "status", "paused_at", "cancelled_at", "owner_told_at", "rides_enabled",
  "cover_file", "cover_version", "cover_approved_at", "cover_approved_by", "cover_media_id", "cover_findings", "cover_pending", "time_public", "location_public", "public_ask",
  "remind_day_before", "remind_soon", "price_cents", "currency", "refund_policy", "refund_hours", "ticket_max"]);
export function updateEventRow(id, fields) {
  const keys = Object.keys(fields).filter(k => EVENT_FIELDS.has(k));
  if (!keys.length) return getEventRow(id);
  db.prepare(`UPDATE events SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...keys.map(k => fields[k]), clock.now(), Number(id));
  return getEventRow(id);
}

export function attendeeRow(eventId, conversationId) {
  return db.prepare("SELECT * FROM event_attendees WHERE event_id = ? AND conversation_id = ?").get(Number(eventId), conversationId) ?? null;
}
export function attendeeById(eventId, id) {
  return db.prepare("SELECT * FROM event_attendees WHERE event_id = ? AND id = ? AND role = 'guest'").get(Number(eventId), Number(id)) ?? null;
}
export function attendeeByToken(token) {
  return db.prepare("SELECT * FROM event_attendees WHERE token = ? AND role = 'guest'").get(String(token ?? "")) ?? null;
}
export function attendeesOf(eventId, { state = "joined" } = {}) {
  return state
    ? db.prepare("SELECT * FROM event_attendees WHERE event_id = ? AND state = ? AND role = 'guest' ORDER BY joined_at, id").all(Number(eventId), state)
    : db.prepare("SELECT * FROM event_attendees WHERE event_id = ? AND role = 'guest' ORDER BY joined_at, id").all(Number(eventId));
}
export function joinedCount(eventId) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM event_attendees WHERE event_id = ? AND state = 'joined' AND role = 'guest'").get(Number(eventId)).n);
}

// Places under the cap that are spoken for without anybody on the list yet: tickets bought for
// friends who have not claimed them (src/eventpay.js registers the count; it owns event_seats).
let reservedCount = () => 0;
export function setReservedPlaces(fn) { reservedCount = typeof fn === "function" ? fn : () => 0; }
export function reservedPlaces(eventId) { return Number(reservedCount(Number(eventId)) || 0); }

/**
 * Put one person on an event, all or nothing, inside a transaction the caller may already hold.
 *
 * The capacity check and the insert are one step, so two people racing for the last place get one
 * place between them. Somebody who left (not somebody removed) may come back, with a fresh token.
 * Returns `{ ok: true, attendee, already }` or `{ ok: false, reason }` — `full`, `removed`.
 */
export function addAttendeeTx({ eventId, conversationId, displayName, instagram = null, inDirectory = false, via, newAccount = false, onSeat = false }) {
  const ev = getEventRow(eventId);
  if (!ev) return { ok: false, reason: "not_found" };
  const prior = attendeeRow(eventId, conversationId);
  if (prior?.role === "organizer") return { ok: false, reason: "organizer" };
  if (prior?.state === "joined") return { ok: true, attendee: prior, already: true };
  if (prior?.state === "removed") return { ok: false, reason: "removed" };
  // A friend claiming a ticket somebody bought them (`onSeat`) takes a place already counted as theirs;
  // everybody else needs one left over once those tickets are counted.
  if (!onSeat && ev.capacity != null && joinedCount(eventId) + reservedPlaces(eventId) >= ev.capacity) return { ok: false, reason: "full" };
  const now = clock.now();
  // On the list by choice only when guests can see the list as they join (see list_chosen).
  const chosen = inDirectory && ev.guest_list_visible ? 1 : 0;
  if (prior) {
    // A rejoin starts with no answers: anything left from before is not theirs to have given again.
    dropAnswersOf(prior.id);
    db.prepare(`UPDATE event_attendees SET state = 'joined', display_name = ?, instagram = ?, in_directory = ?, list_chosen = ?, muted = 0, via = ?, token = ?,
      first_joined_at = COALESCE(first_joined_at, joined_at), joined_at = ?, left_at = NULL, updated_at = ? WHERE id = ?`).run(displayName, instagram, inDirectory ? 1 : 0, chosen, via, newEventToken(32), now, now, prior.id);
  } else {
    db.prepare(`INSERT INTO event_attendees (event_id, conversation_id, display_name, instagram, in_directory, list_chosen, via, token, new_account, joined_at, first_joined_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Number(eventId), conversationId, displayName, instagram, inDirectory ? 1 : 0, chosen, via, newEventToken(32), newAccount ? 1 : 0, now, now, now);
  }
  return { ok: true, attendee: attendeeRow(eventId, conversationId), already: false };
}

export function addAttendee(args) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = addAttendeeTx(args);
    db.exec(out.ok ? "COMMIT" : "ROLLBACK");
    return out;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

/** Leave an event, only from joined: a removal that landed a moment earlier is not turned into a leave. */
export function leaveAttendee(id) {
  const left = db.prepare("UPDATE event_attendees SET state = 'left', left_at = ?, updated_at = ? WHERE id = ? AND state = 'joined' AND role = 'guest'")
    .run(clock.now(), clock.now(), Number(id)).changes === 1;
  // Their answers to the organizer's questions go with them: a guest who comes back answers afresh.
  if (left) dropAnswersOf(id);
  return left;
}
/** A guest's answers on the event they are leaving or were taken off. */
export function dropAnswersOf(attendeeId) {
  db.prepare("DELETE FROM event_answers WHERE attendee_id = ?").run(Number(attendeeId));
  // An ask still owed to somebody off the event is moot; one that went stays, so a rejoin is never asked twice.
  db.prepare("UPDATE event_question_asks SET state = 'dropped', settled_at = ? WHERE attendee_id = ? AND state = 'owed'").run(clock.now(), Number(attendeeId));
}

const ATTENDEE_FIELDS = new Set(["display_name", "instagram", "in_directory", "muted", "state", "left_at", "list_chosen"]);
export function updateAttendeeRow(id, fields) {
  const keys = Object.keys(fields).filter(k => ATTENDEE_FIELDS.has(k));
  // Putting somebody on the who's-going list is their choice when it is a change (they were off it),
  // or when guests can see the list: a page save that leaves a private event's default box ticked is not.
  if (Number(fields.in_directory) === 1) {
    db.prepare(`UPDATE event_attendees SET list_chosen = 1 WHERE id = ? AND (in_directory = 0 OR (SELECT guest_list_visible FROM events WHERE events.id = event_attendees.event_id) = 1)`).run(Number(id));
  }
  if (fields.state === "removed" || fields.state === "left") dropAnswersOf(id);
  if (keys.length) {
    db.prepare(`UPDATE event_attendees SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map(k => fields[k]), clock.now(), Number(id));
  }
  return db.prepare("SELECT * FROM event_attendees WHERE id = ?").get(Number(id)) ?? null;
}

export function recordJoinAttempt({ eventId = null, actor, route, ok, reason = null }) {
  return Number(db.prepare("INSERT INTO event_join_attempts (event_id, actor, route, ok, reason, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(eventId == null ? null : Number(eventId), String(actor), route, ok ? 1 : 0, reason, clock.now()).lastInsertRowid);
}
/** Take back attempts written down as wrong before a check that turned out right. */
export function deleteJoinAttempts(ids) {
  for (const id of ids) db.prepare("DELETE FROM event_join_attempts WHERE id = ? AND ok = 0").run(Number(id));
}
/** This actor's failed attempts since `since`, newest first. */
export function failedJoinAttempts(actor, since) {
  return db.prepare("SELECT at FROM event_join_attempts WHERE actor = ? AND ok = 0 AND at >= ? ORDER BY at DESC").all(String(actor), since);
}
/** One event's joins and wrong passwords since `since`. Wrong ones are counted on the event's own rows. */
export function joinAttemptCounts(eventId, since) {
  const ok = db.prepare("SELECT COUNT(*) AS n FROM event_join_attempts WHERE event_id = ? AND ok = 1 AND at >= ?").get(Number(eventId), since).n;
  const failed = db.prepare("SELECT COUNT(*) AS n FROM event_join_attempts WHERE actor = ? AND ok = 0 AND at >= ?").get(`event:${Number(eventId)}`, since).n;
  return { ok: Number(ok), failed: Number(failed) };
}
/** Sign-in codes a browser asked for since `since` (route `signin`, never an event's join count). */
export function signinRequestsSince(actor, since) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM event_join_attempts WHERE actor = ? AND route = 'signin' AND at >= ?").get(String(actor), since).n);
}
/**
 * When one browser's code requests stop counting against `limit` in a window of `windowMs`: the
 * moment its limit-th most recent request leaves the window, or null when it is under the limit.
 * Reason Web's countdowns ("TRY AGAIN IN 4:59") read this; it is the browser's own, never a number's.
 */
export function signinRequestsClearAt(actor, { limit, windowMs, now = clock.now() }) {
  const rows = db.prepare("SELECT at FROM event_join_attempts WHERE actor = ? AND route = 'signin' AND at >= ? ORDER BY at DESC LIMIT ?")
    .all(String(actor), now - windowMs, limit);
  return rows.length >= limit ? rows[rows.length - 1].at + windowMs : null;
}
/** The same for wrong codes typed from one browser key (src/events.js SIGNIN_WRONG.perBrowser). */
export function pageAttemptsClearAt(key, { limit, windowMs, now = clock.now() }) {
  const rows = db.prepare("SELECT at FROM page_attempts WHERE page_id = ? AND ok = 0 AND at >= ? ORDER BY at DESC LIMIT ?")
    .all(String(key), now - windowMs, limit);
  return rows.length >= limit ? rows[rows.length - 1].at + windowMs : null;
}
/** The last time this browser asked for a sign-in code, or null. */
export function lastSigninRequestAt(actor) {
  return db.prepare("SELECT MAX(at) AS at FROM event_join_attempts WHERE actor = ? AND route = 'signin'").get(String(actor))?.at ?? null;
}
/** Joins since `since` — every one, including people who later left or were taken off. */
export function joinsSince(since) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM event_attendees WHERE joined_at >= ? AND role = 'guest'").get(since).n);
}
/** Every wrong try by a person or browser since `since`, whatever it was aimed at. */
export function failedJoinsSince(since) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM event_join_attempts WHERE actor NOT LIKE 'event:%' AND ok = 0 AND at >= ?").get(since).n);
}

export function insertEventMessage(eventId, kind, body, audience = null) {
  const id = Number(db.prepare("INSERT INTO event_messages (event_id, kind, body, created_at, audience) VALUES (?, ?, ?, ?, ?)")
    .run(Number(eventId), kind, String(body), clock.now(), audience ?? null).lastInsertRowid);
  return db.prepare("SELECT * FROM event_messages WHERE id = ?").get(id);
}
export function eventMessages(eventId, { limit = 20 } = {}) {
  return db.prepare("SELECT * FROM event_messages WHERE event_id = ? ORDER BY id DESC LIMIT ?").all(Number(eventId), limit);
}
/** The same words of the same kind to the same guests of the same event since `since`, if there are any. */
export function recentEventMessage(eventId, kind, body, since, audience = null) {
  return db.prepare("SELECT * FROM event_messages WHERE event_id = ? AND kind = ? AND body = ? AND created_at >= ? AND audience IS ? ORDER BY id DESC LIMIT 1")
    .get(Number(eventId), kind, String(body), since, audience ?? null) ?? null;
}
export function eventMessage(id) {
  return db.prepare("SELECT * FROM event_messages WHERE id = ?").get(Number(id)) ?? null;
}

/** One delivery row per message per guest; a second call for the same pair returns the first. */
export function ensureDelivery({ messageId, eventId, conversationId }) {
  const now = clock.now();
  db.prepare(`INSERT OR IGNORE INTO event_deliveries (message_id, event_id, conversation_id, attempt, idem_key, state, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, 'pending', ?, ?)`).run(Number(messageId), Number(eventId), conversationId, `event:${messageId}:${conversationId}:1`, now, now);
  return db.prepare("SELECT * FROM event_deliveries WHERE message_id = ? AND conversation_id = ?").get(Number(messageId), conversationId);
}
export function deliveryById(id) {
  return db.prepare("SELECT * FROM event_deliveries WHERE id = ?").get(Number(id)) ?? null;
}
export function deliveriesFor(messageId) {
  return db.prepare("SELECT * FROM event_deliveries WHERE message_id = ? ORDER BY id").all(Number(messageId));
}
export function deliveriesForEvent(eventId) {
  return db.prepare("SELECT * FROM event_deliveries WHERE event_id = ? ORDER BY id").all(Number(eventId));
}
export function markDelivery(id, { state, error = null }) {
  db.prepare("UPDATE event_deliveries SET state = ?, last_error = ?, updated_at = ? WHERE id = ?").run(state, error, clock.now(), Number(id));
}
/**
 * Move one delivery to its next attempt, only if it is still on the attempt the caller read. Two
 * retries pressed at once: one moves it, the other finds it already moved and does nothing.
 */
export function bumpDeliveryAttempt(id, fromAttempt) {
  const next = Number(fromAttempt) + 1;
  const row = deliveryById(id);
  if (!row) return null;
  const r = db.prepare(`UPDATE event_deliveries SET attempt = ?, idem_key = ?, state = 'pending', last_error = NULL, updated_at = ?
    WHERE id = ? AND attempt = ?`).run(next, `event:${row.message_id}:${row.conversation_id}:${next}`, clock.now(), Number(id), Number(fromAttempt));
  return r.changes === 1 ? deliveryById(id) : null;
}
/** The outbox rows one delivery attempt became: the key itself, or its numbered parts. */
export function outboxRowsForKey(key) {
  // The key itself, or `key#1`, `key#2`… (src/outbox.js sendSequence). A prefix compare, not LIKE,
  // so an underscore in a key is a character and not a wildcard.
  // A range the unique index on idem_key serves (the status page asks this once per delivery), then
  // the exact match: everything in [key, key#\uffff] is the key, its parts, or never written by us.
  return db.prepare("SELECT id, idem_key, state, last_error, body FROM outbox WHERE idem_key >= ? AND idem_key <= ? ORDER BY id")
    .all(key, `${key}#\uffff`).filter(r => r.idem_key === key || r.idem_key.startsWith(`${key}#`));
}

/**
 * Rewrite the text of one conversation's kept copies since `since` through `fn`: its history, the
 * memory log, stored inbound text and the outbox. For taking an event password out of them
 * (src/events.js scrubPassword). Returns how many rows changed.
 */
const SCRUB_COLUMNS = [
  ["event_log", "content", "at", ""], ["inbound_messages", "text", "received_at", ""], ["inbound_parts", "text", "at", ""],
  // Only messages that have gone: one waiting to go out (or to be retried) is left exactly as it will
  // be sent, and texts Reason has not read yet (pending_inbound) are not touched at all.
  ["outbox", "body", "created_at", " AND state = 'sent'"],
];
/** How many of the newest history messages a scrub reads: the turn that took the password, and a little before. */
export const SCRUB_HISTORY_TAIL = 24;
export function scrubConversationText(conversationId, since, fn) {
  let changed = 0;
  for (const [table, col, at, extra] of SCRUB_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(col) || !cols.includes(at)) continue;
    for (const row of db.prepare(`SELECT rowid AS rid, ${col} AS t FROM ${table} WHERE conversation_id = ? AND ${at} >= ?${extra}`).all(conversationId, since)) {
      if (typeof row.t !== "string") continue;
      const next = fn(row.t);
      if (next !== row.t) { db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`).run(restcrypt.sealCell(table, col, conversationId, next), row.rid); changed++; }
    }
  }
  const walk = (v) => typeof v === "string" ? fn(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  const before = db.prepare("SELECT messages FROM conversations WHERE id = ?").get(conversationId)?.messages;
  if (before) {
    const msgs = JSON.parse(before);
    const cut = Math.max(0, msgs.length - SCRUB_HISTORY_TAIL);
    const after = JSON.stringify([...msgs.slice(0, cut), ...walk(msgs.slice(cut))]);
    if (after !== JSON.stringify(msgs)) { db.prepare("UPDATE conversations SET messages = ? WHERE id = ?").run(restcrypt.sealFor(conversationId, after), conversationId); changed++; }
  }
  return changed;
}

export function insertEventClaim({ eventId, passwordVersion, displayName, instagram = null, inDirectory = false, answers = null, ttlMs, tickets = null, seatId = null, seatVersion = null }) {
  const now = clock.now();
  for (let i = 0; i < 5; i++) {
    try {
      // Answers on a claim nobody finished are not kept past its life: cleared as new claims are made.
      if (i === 0) db.prepare("UPDATE event_claims SET answers = NULL WHERE answers IS NOT NULL AND state = 'open' AND expires_at <= ?").run(now);
      const shown = getEventRow(eventId)?.guest_list_visible ? 1 : 0;
      const id = Number(db.prepare(`INSERT INTO event_claims (event_id, code, password_version, display_name, instagram, in_directory, list_shown, answers, tickets, seat_id, seat_version, state, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(Number(eventId), newClaimCode(), passwordVersion, displayName, instagram, inDirectory ? 1 : 0, shown, answers?.length ? JSON.stringify(answers) : null,
          tickets ?? null, seatId ?? null, seatVersion ?? null, now, now + ttlMs).lastInsertRowid);
      return db.prepare("SELECT * FROM event_claims WHERE id = ?").get(id);
    } catch (e) {
      if (!/UNIQUE/i.test(e?.message ?? "")) throw e;
    }
  }
  throw new Error("could not mint a unique event claim code");
}
export function eventClaimByCode(code) {
  return db.prepare("SELECT * FROM event_claims WHERE code = ?").get(String(code ?? "").toUpperCase()) ?? null;
}

/**
 * Spend one web claim on a join, all or nothing — the event's version of `redeemInvite`.
 *
 * One transaction: the claim goes open → used (the `AND state = 'open'` is what makes a second
 * sender lose), the account is made if this number has none (with `joined_via_event`, no
 * `invited_by`, nobody's allowance touched), and the guest is put on the event under the same
 * capacity check every other route uses. A claim made before the password was rotated, or for an
 * event that is no longer active, does nothing.
 *
 * `{ ok: true, claim, event, attendee, account, newAccount, already }` or `{ ok: false, reason }`
 * with reason one of `not_found`, `used`, `expired`, `password_changed`, `paused`, `cancelled`,
 * `full`, `removed`, `organizer`.
 */
/**
 * A join page's answers (`[{ q, v, choice, answer }]`, already checked when the page took them) put
 * on the guest's row: each under its question only while that question still has the version it had.
 * Returns how many were filed. Call inside the caller's transaction.
 */
export function fileClaimAnswers(eventId, att, raw, via = "join") {
  let list = [];
  try { list = Array.isArray(raw) ? raw : JSON.parse(raw ?? "[]"); } catch { list = []; }
  let n = 0;
  // Only onto somebody still in: a leave or removal racing a save files nothing.
  if (db.prepare("SELECT state FROM event_attendees WHERE id = ?").get(Number(att.id))?.state !== "joined") return 0;
  for (const a of Array.isArray(list) ? list : []) {
    const q = a && eventQuestion(eventId, a.q);
    if (!q || q.version !== a.v || typeof a.answer !== "string" || !a.answer) continue;
    if (q.kind === "choice") {
      const labels = JSON.parse(q.choices ?? "[]");
      if (!Number.isInteger(a.choice) || labels[a.choice] !== a.answer) continue;
    }
    setEventAnswer({ eventId, questionId: q.id, attendeeId: att.id, conversationId: att.conversation_id, choice: q.kind === "choice" ? a.choice : null, answer: a.answer, via });
    n++;
  }
  return n;
}

export function redeemEventClaim({ code, channel, address, existingConversationId = null }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const claim = eventClaimByCode(code);
    const fail = (reason) => { db.exec("ROLLBACK"); return { ok: false, reason, claim }; };
    if (!claim) return fail("not_found");
    if (claim.state !== "open") return fail("used");
    if (claim.expires_at <= clock.now()) return fail("expired");
    const ev = getEventRow(claim.event_id);
    if (!ev) return fail("not_found");
    if (ev.status !== "active") return fail(ev.status);
    // A friend's ticket link stands in for the password (the buyer handed them the place), so a new password doesn't undo it.
    if (!claim.seat_id && ev.password_version !== claim.password_version) return fail("password_changed");
    let conversationId = existingConversationId;
    let newAccount = false;
    if (!conversationId) {
      const known = accountByAddress(channel, address);
      conversationId = known?.conversation_id ?? `dm:${channel}:${address}`;
      if (!known && !getAccount(conversationId)) {
        upsertAccount({ conversationId, channel, address, name: claim.display_name, isOperator: false });
        db.prepare("UPDATE accounts SET joined_via_event = ? WHERE conversation_id = ?").run(ev.id, conversationId);
        // No invites to hand on: an account made through an event starts with none, as one made
        // through an invite does — otherwise a party password would be a way round the invite gate.
        db.prepare(`INSERT INTO invite_allowances (conversation_id, remaining, updated_at) VALUES (?, 0, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET remaining = 0, updated_at = excluded.updated_at`).run(conversationId, clock.now());
        newAccount = true;
      }
    }
    if (conversationId === ev.organizer_conversation_id) return fail("organizer");
    // Ticked while the list was private, used after it was shown: that tick was never a choice.
    const inDirectory = !!claim.in_directory && !(claim.list_shown === 0 && ev.guest_list_visible);
    // A friend's ticket (src/eventpay.js claimSeat): the text proved the phone and made the account;
    // the claim is spent here and the seat is claimed by the caller, under its own checks (still
    // open, the same link). Somebody already in is refused before anything is spent.
    if (claim.seat_id) {
      const prior = attendeeRow(ev.id, conversationId);
      if (prior?.state === "joined") return fail("already");
      if (prior?.state === "removed") return fail("removed");
      const won = db.prepare("UPDATE event_claims SET state = 'used', used_at = ?, used_by = ?, answers = NULL WHERE id = ? AND state = 'open'").run(clock.now(), conversationId, claim.id);
      if (won.changes !== 1) return fail("used");
      db.exec("COMMIT");
      return { ok: true, seat_claim: true, seat_id: claim.seat_id, seat_version: claim.seat_version, claim: eventClaimByCode(code), answers: claim.answers ?? null, event: getEventRow(ev.id), inDirectory, attendee: null, already: false, account: getAccount(conversationId), newAccount };
    }
    // A priced event (src/eventpay.js): the text proved the phone and made the account, and the
    // claim is spent — but nobody is on the event until Stripe says the payment landed. The caller
    // sends the payment link; eventpay.settlePaid does the join from the webhook.
    if (Number(ev.price_cents ?? 0) > 0) {
      const prior = attendeeRow(ev.id, conversationId);
      if (prior?.state === "joined") return fail("already");
      if (prior?.state === "removed") return fail("removed");
      const now = clock.now();
      // The page's answers go with the payment (eventpay.startCheckout → settlePaid files them); the claim keeps no copy.
      const won = db.prepare("UPDATE event_claims SET state = 'used', used_at = ?, used_by = ?, answers = NULL WHERE id = ? AND state = 'open'").run(now, conversationId, claim.id);
      if (won.changes !== 1) return fail("used");
      db.exec("COMMIT");
      return { ok: true, pending_payment: true, tickets: claim.tickets ?? 1, claim: eventClaimByCode(code), answers: claim.answers ?? null, event: getEventRow(ev.id), inDirectory, attendee: null, already: false, account: getAccount(conversationId), newAccount };
    }
    const added = addAttendeeTx({ eventId: ev.id, conversationId, displayName: claim.display_name, instagram: claim.instagram, inDirectory, via: "web_text", newAccount });
    if (!added.ok) return fail(added.reason);
    const now = clock.now();
    // The page's answers are filed below; the claim keeps no copy of them once spent.
    const won = db.prepare("UPDATE event_claims SET state = 'used', used_at = ?, used_by = ?, answers = NULL WHERE id = ? AND state = 'open'").run(now, conversationId, claim.id);
    if (won.changes !== 1) return fail("used");
    // What they answered on the join page, filed now that they are in — and only under a question
    // still worded as it was when they read it (a reworded or removed one drops that answer).
    if (!added.already) fileClaimAnswers(ev.id, added.attendee, claim.answers);
    db.exec("COMMIT");
    return { ok: true, claim: eventClaimByCode(code), event: getEventRow(ev.id), attendee: added.attendee, already: added.already, account: getAccount(conversationId), newAccount };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

// ---------- the event photo album (src/albums.js) ----------
//
// One private album per event, kept separate from the event's own rows so the events feature reads
// exactly as it did. Every row carries a conversation_id, as every table does, and src/albums.js is
// the only reader of these three:
//
//   event_albums     one per event, made the first time anybody touches it. `released_at` is the
//                    moment the organizer ended the event and released the album — nothing else
//                    releases it — and `expires_at` is the one shared deadline (config.albumRetentionDays
//                    after release). `closed_at` is when the sweep deleted the files.
//   event_photos     one per stored picture: whose it is (`conversation_id`), the file under
//                    data/event-albums, its hash (a retry of the same picture from the same person is
//                    not a second photo), and the organizer's pin. Removing one removes the file and the
//                    row: there is no soft delete to keep bytes around.
//   event_checkins   the organizer's check-in list: one row per guest actually there. The ONLY thing
//                    that opens the album to a guest; nothing checks anybody in on its own.
//   album_consents   the one note before a person's first contribution, and when they agreed to it.
db.exec(`
  CREATE TABLE IF NOT EXISTS event_albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    released_at INTEGER,
    expires_at INTEGER,
    closed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS event_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    album_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    media_id INTEGER,
    file TEXT NOT NULL,
    media_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    pinned_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS event_photos_album ON event_photos (album_id, created_at, id);
  CREATE INDEX IF NOT EXISTS event_photos_person ON event_photos (conversation_id, album_id);
  CREATE TABLE IF NOT EXISTS event_checkins (
    event_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    checked_in_by TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (event_id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS album_consents (
    conversation_id TEXT PRIMARY KEY,
    asked_at INTEGER,
    agreed_at INTEGER
  );
`);
// `nudged_at`: when the organizer was told, once, around the event's end, that nobody is checked in.
addColumnIfMissing("event_albums", "nudged_at", "INTEGER");

export function albumOf(eventId) {
  return db.prepare("SELECT * FROM event_albums WHERE event_id = ?").get(Number(eventId)) ?? null;
}
export function albumById(id) {
  return db.prepare("SELECT * FROM event_albums WHERE id = ?").get(Number(id)) ?? null;
}
/** The event's album, made now if it has none. `conversationId` is the organizer's: the album is theirs. */
export function ensureAlbum(eventId, conversationId) {
  const now = clock.now();
  db.prepare("INSERT OR IGNORE INTO event_albums (event_id, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(Number(eventId), conversationId, now, now);
  return albumOf(eventId);
}
const ALBUM_FIELDS = new Set(["released_at", "expires_at", "closed_at", "nudged_at"]);
export function updateAlbum(id, fields) {
  const keys = Object.keys(fields).filter(k => ALBUM_FIELDS.has(k));
  if (keys.length) db.prepare(`UPDATE event_albums SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map(k => fields[k]), clock.now(), Number(id));
  return albumById(id);
}
/** Release, compare-and-set on it not being released yet: the one caller that wins sends the announcement. */
export function releaseAlbum(id, { releasedAt, expiresAt }) {
  return db.prepare("UPDATE event_albums SET released_at = ?, expires_at = ?, updated_at = ? WHERE id = ? AND released_at IS NULL").run(releasedAt, expiresAt, clock.now(), Number(id)).changes === 1;
}
/** Albums past their deadline and not yet closed: the sweep's list. */
export function albumsToClose(now = clock.now()) {
  return db.prepare("SELECT * FROM event_albums WHERE expires_at IS NOT NULL AND expires_at <= ? AND closed_at IS NULL ORDER BY expires_at, id").all(now);
}
/** Albums with photos that were never released: waiting on the organizer (an open product decision). */
export function albumsWaiting() {
  return db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM event_photos p WHERE p.album_id = a.id) AS photos FROM event_albums a
    WHERE a.released_at IS NULL AND photos > 0 ORDER BY a.created_at`).all();
}
/** Never-released albums with photos whose organizer has not had the end-of-event nudge (src/albums.js sweep). */
export function albumsToNudge() {
  return db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM event_photos p WHERE p.album_id = a.id) AS photos FROM event_albums a
    WHERE a.released_at IS NULL AND a.closed_at IS NULL AND a.nudged_at IS NULL AND photos > 0 ORDER BY a.created_at`).all();
}
/** The end-of-event nudge, compare-and-set: the one caller that wins is the one that sends it. */
export function markAlbumNudged(id, at) {
  return db.prepare("UPDATE event_albums SET nudged_at = ?, updated_at = ? WHERE id = ? AND nudged_at IS NULL").run(at, clock.now(), Number(id)).changes === 1;
}

export function insertPhoto({ albumId, eventId, conversationId, mediaId = null, file, mediaType, bytes, sha256 }) {
  const id = Number(db.prepare(`INSERT INTO event_photos (album_id, event_id, conversation_id, media_id, file, media_type, bytes, sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Number(albumId), Number(eventId), conversationId, mediaId == null ? null : Number(mediaId), file, mediaType, Number(bytes), sha256, clock.now()).lastInsertRowid);
  return photoById(id);
}
export function photoById(id) {
  return db.prepare("SELECT * FROM event_photos WHERE id = ?").get(Number(id)) ?? null;
}
/** The same bytes from the same person in the same album: a retry or a double-send, not a second photo. */
export function photoByHash(albumId, conversationId, sha256) {
  return db.prepare("SELECT * FROM event_photos WHERE album_id = ? AND conversation_id = ? AND sha256 = ?").get(Number(albumId), conversationId, sha256) ?? null;
}
/**
 * Every photo in one album, in THE one order (src/albums.js PHOTO_ORDER, decided 2026-10-26: upload time). Pinned ones
 * are not lifted here — the page puts highlights on top itself, in the order they were pinned.
 */
export function photosOf(albumId) {
  return db.prepare("SELECT * FROM event_photos WHERE album_id = ? ORDER BY created_at, id").all(Number(albumId));
}
export function photosBy(albumId, conversationId) {
  return db.prepare("SELECT * FROM event_photos WHERE album_id = ? AND conversation_id = ? ORDER BY created_at, id").all(Number(albumId), conversationId);
}
export function photoCount(albumId) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM event_photos WHERE album_id = ?").get(Number(albumId)).n);
}
export function contributorCount(albumId) {
  return Number(db.prepare("SELECT COUNT(DISTINCT conversation_id) AS n FROM event_photos WHERE album_id = ?").get(Number(albumId)).n);
}
export function pinPhoto(id, pinnedAt) {
  db.prepare("UPDATE event_photos SET pinned_at = ? WHERE id = ?").run(pinnedAt, Number(id));
  return photoById(id);
}
/** The row goes here; the file is the caller's to unlink first (src/albums.js removePhoto). */
export function deletePhotoRow(id) {
  return db.prepare("DELETE FROM event_photos WHERE id = ?").run(Number(id)).changes === 1;
}

export function checkIn(eventId, conversationId, by) {
  return db.prepare("INSERT OR IGNORE INTO event_checkins (event_id, conversation_id, checked_in_by, at) VALUES (?, ?, ?, ?)").run(Number(eventId), conversationId, by, clock.now()).changes === 1;
}
export function undoCheckIn(eventId, conversationId) {
  return db.prepare("DELETE FROM event_checkins WHERE event_id = ? AND conversation_id = ?").run(Number(eventId), conversationId).changes === 1;
}
export function checkedIn(eventId, conversationId) {
  return !!db.prepare("SELECT 1 FROM event_checkins WHERE event_id = ? AND conversation_id = ?").get(Number(eventId), conversationId);
}
export function checkinsOf(eventId) {
  return db.prepare("SELECT * FROM event_checkins WHERE event_id = ? ORDER BY at, rowid").all(Number(eventId));
}

export function albumConsent(conversationId) {
  return db.prepare("SELECT * FROM album_consents WHERE conversation_id = ?").get(conversationId) ?? null;
}
export function askAlbumConsent(conversationId, at) {
  db.prepare("INSERT INTO album_consents (conversation_id, asked_at) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET asked_at = excluded.asked_at").run(conversationId, at);
  return albumConsent(conversationId);
}
export function agreeAlbumConsent(conversationId, at) {
  db.prepare("INSERT INTO album_consents (conversation_id, asked_at, agreed_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET agreed_at = excluded.agreed_at").run(conversationId, at, at);
  return albumConsent(conversationId);
}

// ---------- per-person zone (src/zone.js) ----------

/** Everything known about where this person's clock is, in one read. */
export function zoneRow(conversationId) {
  const row = db.prepare(`SELECT channel, address, is_operator, notice_tz, tz_confirmed_at, web_tz, place_tz, place_tz_at,
      tz_travel_asked, tz_pending FROM accounts WHERE conversation_id = ?`).get(conversationId);
  if (!row) return null;
  let pending = null;
  try { pending = row.tz_pending ? JSON.parse(row.tz_pending) : null; } catch { pending = null; }
  return {
    channel: row.channel, address: row.address, isOperator: !!row.is_operator,
    confirmed: row.notice_tz || "", confirmedAt: row.tz_confirmed_at ?? null,
    web: row.web_tz || "", place: row.place_tz || "", placeAt: row.place_tz_at ?? null,
    travelAsked: row.tz_travel_asked || "", pending,
  };
}

/** Write any of the zone fields. `pending` is an object or null; the rest are strings / numbers. */
export function setZoneFields(conversationId, { confirmed, confirmedAt, web, place, placeAt, travelAsked, pending } = {}) {
  const set = (col, v) => db.prepare(`UPDATE accounts SET ${col} = ? WHERE conversation_id = ?`).run(v, conversationId);
  if (confirmed !== undefined) set("notice_tz", confirmed);
  if (confirmedAt !== undefined) set("tz_confirmed_at", confirmedAt);
  if (web !== undefined) set("web_tz", web);
  if (place !== undefined) set("place_tz", place);
  if (placeAt !== undefined) set("place_tz_at", placeAt);
  if (travelAsked !== undefined) set("tz_travel_asked", travelAsked);
  if (pending !== undefined) set("tz_pending", pending === null ? null : JSON.stringify(pending));
  return zoneRow(conversationId);
}

/** The operator's own account(s) start confirmed on the install's zone. Returns how many were set. */
export function preconfirmOperatorZone(tz, at = clock.now()) {
  return db.prepare(`UPDATE accounts SET notice_tz = ?, tz_confirmed_at = ?
    WHERE is_operator = 1 AND (notice_tz IS NULL OR notice_tz = '')`).run(tz, at).changes;
}

// ---------- choice cards (src/choicecards.js) ----------
// One row per set of options Reason showed: what each number was, the provider handle of each card
// (so an inline reply on card 3 is read as card 3), and until when their next message may be the
// answer. A new set closes the one before; an answer or the clock closes it too.
db.exec(`
  CREATE TABLE IF NOT EXISTS choice_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    options TEXT NOT NULL,
    handles TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    shown_at INTEGER,
    expires_at INTEGER NOT NULL,
    closed_at INTEGER,
    reads INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS choice_sets_conv ON choice_sets(conversation_id, id);
`);

const choiceOut = (r) => r ? { ...r, options: JSON.parse(r.options || "[]"), handles: JSON.parse(r.handles || "[]") } : null;

export function openChoiceSet({ conversationId, kind, options, state, expiresAt, at = clock.now() }) {
  db.prepare("UPDATE choice_sets SET closed_at = ? WHERE conversation_id = ? AND closed_at IS NULL").run(at, conversationId);
  const id = db.prepare("INSERT INTO choice_sets (conversation_id, kind, options, state, created_at, shown_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(conversationId, kind, JSON.stringify(options), state, at, state === "text" ? at : null, expiresAt).lastInsertRowid;
  return choiceOut(db.prepare("SELECT * FROM choice_sets WHERE id = ?").get(id));
}
export function setChoiceState(id, state) {
  db.prepare("UPDATE choice_sets SET state = ?, closed_at = CASE WHEN ? = 'dropped' THEN ? ELSE closed_at END WHERE id = ?").run(state, state, clock.now(), id);
}
export function setChoiceShown(id, { handles = [], state = "shown", at = clock.now() } = {}) {
  db.prepare("UPDATE choice_sets SET handles = ?, state = ?, shown_at = ?, closed_at = CASE WHEN ? = 'dropped' THEN ? ELSE closed_at END WHERE id = ?")
    .run(JSON.stringify(handles), state, at, state, at, id);
}
/** The set their next message may be answering: open, shown (or written as a list), not expired. */
export function openChoiceFor(conversationId, now = clock.now()) {
  return choiceOut(db.prepare(`SELECT * FROM choice_sets WHERE conversation_id = ? AND closed_at IS NULL
    AND state IN ('shown', 'partial', 'text') AND expires_at > ? AND reads < ? ORDER BY id DESC LIMIT 1`).get(conversationId, now, CHOICE_READS));
}
/** How many of their messages a set is read against before it is let go: a pick, a question about one, a pick. */
export const CHOICE_READS = 3;
export function countChoiceRead(id) {
  db.prepare("UPDATE choice_sets SET reads = reads + 1 WHERE id = ?").run(id);
}
export function closeChoiceSets(conversationId, at = clock.now()) {
  return db.prepare("UPDATE choice_sets SET closed_at = ? WHERE conversation_id = ? AND closed_at IS NULL").run(at, conversationId).changes;
}

// ---------- to-do lists (src/todo.js, REASON_TODO) ----------
// A list somebody sent (a photo or typed), the plan Reason made of it, and the one approval of the
// whole plan. Its own two tables rather than a `plans` row: a plan there is one social arrangement
// (who, when, where, locked once nobody has questions), and a list is many unrelated jobs, each with
// its own group, its own job row and its own state. Folding both into `plans.data` would have put a
// second meaning on every plan_* tool and on the nudges that read plans.
//
//   todo_lists  one per list. `grant` is the businesses the approved plan named, copied at the moment
//               of approval: the only thing the list's grant may ever cover (todo.js grantCovering).
//               `wrapped_at` is claimed before the wrap-up text goes, so it goes once.
//   todo_items  one per line on the list, in the order written. `task_id` is the job working it, when
//               there is one; `status` is read off that job whenever it changes.
db.exec(`
  CREATE TABLE IF NOT EXISTS todo_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'text',
    state TEXT NOT NULL DEFAULT 'planning',
    page_id TEXT,
    plan_fp TEXT NOT NULL DEFAULT '',
    approval_confirmation_id INTEGER,
    approved_quote TEXT,
    approved_at INTEGER,
    grant_json TEXT NOT NULL DEFAULT '[]',
    wrapped_at INTEGER,
    wrap_text TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS todo_lists_conv ON todo_lists(conversation_id, id);
  CREATE TABLE IF NOT EXISTS todo_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    text TEXT NOT NULL,
    short TEXT NOT NULL DEFAULT '',
    grp TEXT NOT NULL,
    how TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL DEFAULT '',
    money INTEGER NOT NULL DEFAULT 0,
    money_note TEXT NOT NULL DEFAULT '',
    businesses TEXT NOT NULL DEFAULT '[]',
    task_id INTEGER,
    status TEXT NOT NULL DEFAULT 'todo',
    note TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS todo_items_list ON todo_items(list_id, n);
  CREATE INDEX IF NOT EXISTS todo_items_task ON todo_items(task_id);
`);

const todoListOut = (r) => r ? { ...r, grant: JSON.parse(r.grant_json || "[]") } : null;
const todoItemOut = (r) => r ? { ...r, money: !!r.money, businesses: JSON.parse(r.businesses || "[]") } : null;

/** A new list, or a planning list's items replaced (a revised plan). Items in the order given. */
export function saveTodoList(conversationId, { listId = null, title = "", source = "text", items = [], planFp = "" }) {
  const now = clock.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    let id = listId;
    if (id) {
      // Only their own list: a list id that is not theirs changes nothing and adds nothing (isolation
      // 11-09; before, the items of whoever owned that id were deleted and theirs written under it).
      const mine = db.prepare("UPDATE todo_lists SET title = ?, source = ?, plan_fp = ?, updated_at = ? WHERE id = ? AND conversation_id = ?")
        .run(title, source, planFp, now, id, conversationId);
      if (mine.changes !== 1) throw new Error(`No to-do list #${id}`);
      db.prepare("DELETE FROM todo_items WHERE list_id = ? AND conversation_id = ?").run(id, conversationId);
    } else {
      id = Number(db.prepare("INSERT INTO todo_lists (conversation_id, title, source, plan_fp, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(conversationId, title, source, planFp, now, now).lastInsertRowid);
    }
    const put = db.prepare(`INSERT INTO todo_items (list_id, conversation_id, n, text, short, grp, how, question, money, money_note, businesses, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    items.forEach((it, i) => put.run(id, conversationId, i + 1, it.text, it.short ?? "", it.grp, it.how ?? "", it.question ?? "",
      it.money ? 1 : 0, it.money_note ?? "", JSON.stringify(it.businesses ?? []), it.status ?? "todo", now));
    db.exec("COMMIT");
    return getTodoList(conversationId, id);
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* nothing open */ }
    throw e;
  }
}
export function getTodoList(conversationId, id) {
  return todoListOut(db.prepare("SELECT * FROM todo_lists WHERE id = ? AND conversation_id = ?").get(Number(id), conversationId));
}
export function getTodoListAnywhere(id) {
  return todoListOut(db.prepare("SELECT * FROM todo_lists WHERE id = ?").get(Number(id)));
}
/** Lists whose approval is still working: approved, not closed. Newest first. */
export function approvedTodoLists(conversationId) {
  return db.prepare("SELECT * FROM todo_lists WHERE conversation_id = ? AND state = 'approved' ORDER BY id DESC").all(conversationId).map(todoListOut);
}
export function listTodoLists(conversationId, { includeClosed = false } = {}) {
  const sql = includeClosed
    ? "SELECT * FROM todo_lists WHERE conversation_id = ? ORDER BY id DESC LIMIT 20"
    : "SELECT * FROM todo_lists WHERE conversation_id = ? AND state IN ('planning', 'approved') ORDER BY id DESC LIMIT 20";
  return db.prepare(sql).all(conversationId).map(todoListOut);
}
export function todoItems(listId) {
  return db.prepare("SELECT * FROM todo_items WHERE list_id = ? ORDER BY n").all(Number(listId)).map(todoItemOut);
}
export function todoItemsForTask(taskId) {
  return db.prepare("SELECT * FROM todo_items WHERE task_id = ?").all(Number(taskId)).map(todoItemOut);
}
export function setTodoListPage(id, pageId) {
  db.prepare("UPDATE todo_lists SET page_id = ?, updated_at = ? WHERE id = ?").run(pageId, clock.now(), id);
}
/** Planning → approved, once. The grant is copied here and never widened by a later edit of the items. */
export function approveTodoList(conversationId, id, { confirmationId, quote, grant }) {
  const now = clock.now();
  return db.prepare(`UPDATE todo_lists SET state = 'approved', approval_confirmation_id = ?, approved_quote = ?, approved_at = ?,
    grant_json = ?, updated_at = ? WHERE id = ? AND conversation_id = ? AND state = 'planning'`)
    .run(confirmationId ?? null, quote ?? "", now, JSON.stringify(grant ?? []), now, id, conversationId).changes === 1;
}
export function setTodoGrant(id, grant) {
  db.prepare("UPDATE todo_lists SET grant_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(grant ?? []), clock.now(), id);
}
export function closeTodoList(conversationId, id, state = "closed") {
  return db.prepare("UPDATE todo_lists SET state = ?, closed_at = ?, updated_at = ? WHERE id = ? AND conversation_id = ? AND state IN ('planning', 'approved')")
    .run(state, clock.now(), clock.now(), id, conversationId).changes === 1;
}
export function updateTodoItem(id, fields) {
  const cols = ["short", "grp", "how", "question", "task_id", "status", "note", "businesses", "money", "money_note"];
  const sets = [];
  const args = [];
  for (const k of cols) {
    if (fields[k] === undefined) continue;
    sets.push(`${k} = ?`);
    args.push(k === "businesses" ? JSON.stringify(fields[k]) : k === "money" ? (fields[k] ? 1 : 0) : fields[k]);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?"); args.push(clock.now());
  db.prepare(`UPDATE todo_items SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
}
/** Claim the one wrap-up. True for exactly one caller, ever, per list. */
export function claimTodoWrap(id, text) {
  return db.prepare("UPDATE todo_lists SET wrapped_at = ?, wrap_text = ? WHERE id = ? AND wrapped_at IS NULL AND state = 'approved'")
    .run(clock.now(), String(text ?? ""), id).changes === 1;
}
/** Approved lists not wrapped up yet, across every conversation: the sweep's candidates. */
export function todoListsAwaitingWrap() {
  return db.prepare("SELECT * FROM todo_lists WHERE state = 'approved' AND wrapped_at IS NULL ORDER BY id").all().map(todoListOut);
}
/** What knownPersonByNumber says for a number that is another person's own Reason: never their name. */
export const OTHER_ACCOUNT_WHO = "a person, not a business";
/** Is this number written down as a way of reaching somebody they know? Digits only, by exact match. */
export function knownPersonByNumber(conversationId, number) {
  const ten = String(number ?? "").replace(/\D/g, "").slice(-10);
  if (ten.length < 7) return null;
  const same = (s) => { const d = String(s ?? "").replace(/\D/g, ""); return d.length >= 7 && d.slice(-10) === ten; };
  for (const p of listImportantPeople(conversationId)) {
    if ((p.contacts ?? []).some(same)) return { who: p.who, from: "important_people" };
  }
  // Somebody with a Reason of their own on this install is a person, whatever the plan called them.
  // Their account name is THEIRS, not the asker's, so it is never returned (isolation 11-09: a number
  // typed into permission_grant came back "on record as <their registered name>"). The asker learns
  // only what gates the ask: this is a person, not a business.
  for (const a of db.prepare("SELECT address FROM accounts WHERE address IS NOT NULL AND address != ''").all()) {
    if (same(a.address)) return { who: OTHER_ACCOUNT_WHO, from: "accounts" };
  }
  // A person in memory filed under the number itself, or with the number among their facts. Each
  // phone-shaped run in a fact is compared whole, so a longer number never matches by containing it.
  for (const p of db.prepare("SELECT id, name FROM people WHERE conversation_id = ?").all(conversationId)) {
    if (same(p.name)) return { who: p.name, from: "people" };
    for (const f of db.prepare("SELECT fact FROM person_facts WHERE person_id = ?").all(p.id)) {
      for (const run of String(f.fact).match(/\+?\d[\d\s().-]{5,}\d/g) ?? []) {
        if (same(run)) return { who: p.name, from: "people" };
      }
    }
  }
  return null;
}
/** Is this name somebody in their memory or on their people list? Exact name key, no reading. */
export function knownPersonByName(conversationId, name) {
  const key = personKey(name);
  if (!key) return null;
  const p = db.prepare("SELECT name FROM people WHERE conversation_id = ? AND key = ?").get(conversationId, key);
  if (p) return { who: p.name, from: "people" };
  const imp = db.prepare("SELECT who FROM important_people WHERE conversation_id = ? AND who_key = ?").get(conversationId, String(name ?? "").trim().toLowerCase().replace(/\s+/g, " "));
  return imp ? { who: imp.who, from: "important_people" } : null;
}

// ---------- how to treat me: rules from their own corrections (src/dream.js, the remember tool) ----------
//
// When somebody puts Reason right about how it BEHAVES — "don't text me before 9", "lead with the
// price", "stop sending me three options" — that is not a fact about them, it is a rule for Reason.
// Kept apart from person_facts so it rides on every turn (src/memorynote.js) instead of competing
// for a profile slot, and so the nightly review can merge and retire rules without touching facts.
// Every query is scoped by conversation_id: one person's rules are never read on another's turn.
//
// status: active | deleted (they took it back: never comes back from a review) | superseded (merged
// into `superseded_by`, or retired by a later message). Nothing is ever hard-deleted here except by a
// data delete (src/data.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS treat_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    rule TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    why TEXT NOT NULL DEFAULT '',
    source_message_id INTEGER,
    source TEXT NOT NULL DEFAULT 'they_said',
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by INTEGER,
    created_at INTEGER NOT NULL,
    retired_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS treat_rules_conv ON treat_rules (conversation_id, status);
  CREATE TABLE IF NOT EXISTS memory_reviews (
    conversation_id TEXT PRIMARY KEY,
    last_event_id INTEGER NOT NULL DEFAULT 0,
    last_day TEXT NOT NULL DEFAULT '',
    reviewed_at INTEGER,
    last_outcome TEXT NOT NULL DEFAULT ''
  );
  -- One row per person per pass that asked the model: what it cost and what it changed. Counts and
  -- token numbers only, never a fact, a rule or a message. cost_usd is the API-equivalent (list
  -- price) of the run, from the CLI's own total_cost_usd, else priced off the token counts.
  CREATE TABLE IF NOT EXISTS memory_review_passes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    day TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL,
    outcome TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
    cost_usd REAL, cost_from TEXT NOT NULL DEFAULT '',
    messages INTEGER NOT NULL DEFAULT 0, facts INTEGER NOT NULL DEFAULT 0, rules INTEGER NOT NULL DEFAULT 0,
    kept INTEGER NOT NULL DEFAULT 0, corrected INTEGER NOT NULL DEFAULT 0, merged INTEGER NOT NULL DEFAULT 0,
    retired INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0,
    rules_added INTEGER NOT NULL DEFAULT 0, rules_merged INTEGER NOT NULL DEFAULT 0,
    rules_retired INTEGER NOT NULL DEFAULT 0, rules_capped INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS memory_review_passes_day ON memory_review_passes (day, conversation_id);
`);
// The last pass's model and $ on the watermark row too, for a glance (the history is the table above).
// attempted_at: when a pass was last queued (kept on disk so a restart storm cannot re-ask the model);
// patterns_at: when the patterns-across-days pass last ran for them.
for (const col of ["last_model TEXT NOT NULL DEFAULT ''", "last_cost_usd REAL", "attempted_at INTEGER", "patterns_at INTEGER"]) {
  try { db.exec(`ALTER TABLE memory_reviews ADD COLUMN ${col}`); } catch { /* already there */ }
}

const PASS_COUNTS = ["messages", "facts", "rules", "kept", "corrected", "merged", "retired", "refused", "rules_added", "rules_merged", "rules_retired", "rules_capped"];
const intOrNull = (v) => v != null && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null;

/** One review pass that asked the model, per person: tokens, API-equivalent $, and counts. */
export function recordMemoryReviewPass(conversationId, { day = "", at = clock.now(), outcome = "", model = "", usage = null, costUsd = null, costFrom = "", counts = {} } = {}) {
  const u = usage ?? {};
  const cost = Number.isFinite(costUsd) ? costUsd : null;
  const cols = ["conversation_id", "day", "at", "outcome", "model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd", "cost_from", ...PASS_COUNTS];
  const vals = [conversationId, String(day ?? ""), at, String(outcome).slice(0, 40), String(model ?? "").slice(0, 80),
    intOrNull(u.input_tokens), intOrNull(u.output_tokens), intOrNull(u.cache_read_input_tokens), intOrNull(u.cache_creation_input_tokens),
    cost, String(costFrom ?? ""), ...PASS_COUNTS.map(k => Number(counts[k]) || 0)];
  db.prepare(`INSERT INTO memory_review_passes (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
  db.prepare("UPDATE memory_reviews SET last_model = ?, last_cost_usd = ? WHERE conversation_id = ?").run(String(model ?? "").slice(0, 80), cost, conversationId);
}

/** For tests and the status page: one person's passes, oldest first. */
export function memoryReviewPasses(conversationId) {
  return db.prepare("SELECT * FROM memory_review_passes WHERE conversation_id = ? ORDER BY id").all(conversationId);
}

/** The hard cap on active rules per person. Past it the nightly review consolidates. */
export const RULES_CAP = 8;
/** In-turn ceiling: a few over the cap is allowed until the night, never an unbounded pile. */
export const RULES_CEILING = 12;

const ruleRow = (r) => r ? { ...r } : null;

/** Their active rules, newest first. */
export function activeRules(conversationId, { limit = 50 } = {}) {
  return db.prepare("SELECT * FROM treat_rules WHERE conversation_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(conversationId, limit);
}

/** One active rule, inside this conversation only. */
export function getRule(conversationId, id) {
  return ruleRow(db.prepare("SELECT * FROM treat_rules WHERE id = ? AND conversation_id = ? AND status = 'active'").get(id, conversationId));
}

/**
 * Save a rule. `source` 'they_said' (the in-turn tool, on their word) or 'review' (the nightly pass).
 * A rule they deleted is never brought back by a review; only their own word revives it. The same
 * rule already active is not doubled. Past the ceiling an in-turn save is refused.
 */
export function addRule(conversationId, { rule, why = "", sourceMessageId = null, source = "they_said", at = clock.now() } = {}) {
  const clean = String(rule ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!clean) return { ok: false, error: "empty" };
  const key = normalize(clean);
  const same = db.prepare("SELECT * FROM treat_rules WHERE conversation_id = ? AND pt(rule_key) = ? ORDER BY id DESC").all(conversationId, key);
  const active = same.find(r => r.status === "active");
  if (active) return { ok: true, already: true, rule: active };
  const takenBack = same.find(r => r.status === "deleted");
  if (takenBack && source !== "they_said") return { ok: false, refused: "taken_back", error: "they took that one back" };
  if (activeRules(conversationId, { limit: RULES_CEILING + 1 }).length >= RULES_CEILING) {
    return { ok: false, refused: "too_many", error: `there are already ${RULES_CEILING} rules; replace one instead of adding` };
  }
  const msg = Number.isInteger(Number(sourceMessageId)) && Number(sourceMessageId) > 0 ? Number(sourceMessageId) : null;
  const r = db.prepare(`INSERT INTO treat_rules (conversation_id, rule, rule_key, why, source_message_id, source, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`).run(conversationId, seal2(conversationId, clean), seal2(conversationId, key),
      seal2(conversationId, String(why ?? "").trim().slice(0, 300)), msg, source, at);
  return { ok: true, rule: getRule(conversationId, Number(r.lastInsertRowid)) };
}

/** They took one back. It stays on disk as 'deleted' so a review can never revive it. */
export function dropRule(conversationId, id, { at = clock.now() } = {}) {
  const row = getRule(conversationId, id);
  if (!row) return { ok: false, error: `There is no rule #${id} here.` };
  db.prepare("UPDATE treat_rules SET status = 'deleted', retired_at = ? WHERE id = ?").run(at, id);
  return { ok: true, was: row };
}

/** Retired by the review: contradicted later, or folded into `by`. Not theirs to have taken back. */
export function supersedeRule(conversationId, id, { by = null, at = clock.now() } = {}) {
  const row = getRule(conversationId, id);
  if (!row) return { ok: false, error: "not an active rule here" };
  if (by != null && (by === id || !db.prepare("SELECT 1 FROM treat_rules WHERE id = ? AND conversation_id = ?").get(by, conversationId))) {
    return { ok: false, error: "not a rule here" };
  }
  db.prepare("UPDATE treat_rules SET status = 'superseded', superseded_by = ?, retired_at = ? WHERE id = ?").run(by, at, id);
  return { ok: true, was: row };
}

/** The newest user message in this conversation: what an in-turn rule came from. */
export function latestUserEventId(conversationId) {
  return db.prepare("SELECT id FROM event_log WHERE conversation_id = ? AND role = 'user' ORDER BY at DESC, id DESC LIMIT 1").get(conversationId)?.id ?? null;
}

// ---------- the nightly memory review (src/dream.js) ----------

export function memoryReviewState(conversationId) {
  return db.prepare("SELECT * FROM memory_reviews WHERE conversation_id = ?").get(conversationId)
    ?? { conversation_id: conversationId, last_event_id: 0, last_day: "", reviewed_at: null, last_outcome: "" };
}

/** Record a night's pass. `lastEventId` moves only when the pass really read up to it. */
export function markMemoryReview(conversationId, { day, lastEventId = null, outcome = "", at = clock.now() }) {
  const was = memoryReviewState(conversationId);
  const last = lastEventId == null ? was.last_event_id : Math.max(was.last_event_id, Number(lastEventId));
  db.prepare(`INSERT INTO memory_reviews (conversation_id, last_event_id, last_day, reviewed_at, last_outcome) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET last_event_id = excluded.last_event_id, last_day = excluded.last_day,
      reviewed_at = excluded.reviewed_at, last_outcome = excluded.last_outcome`).run(conversationId, last, String(day ?? ""), at, String(outcome).slice(0, 40));
}

/**
 * A pass is about to be asked for (queued): written before the model is, so a restart in the middle
 * of it does not ask again the moment the process is back (src/dream.js, the catch-up's rate limit).
 */
export function noteMemoryReviewAttempt(conversationId, at = clock.now()) {
  db.prepare(`INSERT INTO memory_reviews (conversation_id, attempted_at) VALUES (?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET attempted_at = excluded.attempted_at`).run(conversationId, at);
}

/** How many passes asked the model for them on this (their own) day. */
export function memoryReviewPassesOn(conversationId, day) {
  return db.prepare("SELECT COUNT(*) AS n FROM memory_review_passes WHERE conversation_id = ? AND day = ?").get(conversationId, String(day ?? ""))?.n ?? 0;
}

/** The patterns-across-days pass ran (or was tried) for them at `at`. */
export function markPatternPass(conversationId, at = clock.now()) {
  db.prepare(`INSERT INTO memory_reviews (conversation_id, patterns_at) VALUES (?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET patterns_at = excluded.patterns_at`).run(conversationId, at);
}

/**
 * What they said on their OWN phone calls, as SQL on an event_log alias: a call line (role
 * call_user) whose call row is theirs. The other side of a call Reason made for them (a business,
 * another person) is never the person speaking, so it never counts as "they said something".
 */
export const saidOnOwnCall = (alias) => `(${alias}.role = 'call_user' AND ${alias}.channel = 'call' AND EXISTS (SELECT 1 FROM calls k
  WHERE k.id = CAST(${alias}.message_id AS INTEGER) AND k.conversation_id = ${alias}.conversation_id AND k.is_owner = 1))`;

/** Has anything been said since `afterId`? One indexed query. `calls`: what they said on their own calls counts too. `before`: only what was said before that time. */
export function hasEventsSince(conversationId, afterId = 0, { calls = false, before = null } = {}) {
  const until = Number.isFinite(before) ? " AND e.at < ?" : "";
  return !!db.prepare(`SELECT 1 FROM event_log e WHERE e.conversation_id = ? AND e.id > ?${until} AND (e.role = 'user'${calls ? ` OR ${saidOnOwnCall("e")}` : ""}) LIMIT 1`)
    .get(...[conversationId, Number(afterId) || 0, ...(until ? [before] : [])]);
}

/**
 * Not a line they asked Reason to forget (forgetFromRecall), as SQL on an event_log alias. The same
 * tombstone recall reads (src/recallindex.js); the nightly review reads through it too.
 */
export const eventNotForgotten = (alias) => `NOT EXISTS (SELECT 1 FROM recall_forgotten f WHERE f.conversation_id = ${alias}.conversation_id AND f.source_table = 'event_log' AND f.row_id = ${alias}.id)`;

/** Event rows by id, this conversation only: a fact's source messages, resolved. Never a forgotten line. */
export function eventsByIds(conversationId, ids) {
  const want = [...new Set((ids ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 400);
  if (!want.length) return [];
  return db.prepare(`SELECT e.id, e.role, e.content, e.at FROM event_log e WHERE e.conversation_id = ? AND e.id IN (${want.map(() => "?").join(",")}) AND ${eventNotForgotten("e")}`)
    .all(conversationId, ...want);
}

/**
 * Did a rule they took back (dropRule, a forget, a reword on the Web page) come from this message? A
 * review must not re-learn it from the same words, reworded or not.
 */
export function ruleTakenBackFrom(conversationId, messageId) {
  const id = Number(messageId);
  if (!Number.isInteger(id) || id <= 0) return false;
  return !!db.prepare("SELECT 1 FROM treat_rules WHERE conversation_id = ? AND source_message_id = ? AND status = 'deleted' LIMIT 1").get(conversationId, id);
}

/**
 * What a permanently forgotten fact's row holds instead of its words (src/ios/memory.js): a one-way
 * fingerprint of subject and wording. It is how Reason can still refuse to re-learn a sentence from
 * messages it re-reads, without keeping the sentence.
 */
export function forgottenMark(personId, key) {
  return `forgotten:${createHash("sha256").update(`${personId}:${key}`).digest("hex")}`;
}
export const isForgottenMark = (fact) => /^forgotten:[0-9a-f]{64}$/.test(String(fact ?? ""));

/**
 * Has the person taken back this wording about this subject (memory_drop, memory_fix)? A review must
 * never write a sentence they removed.
 */
export function factTakenBack(conversationId, personId, fact) {
  const key = factKey(fact);
  return db.prepare(`SELECT f.fact FROM person_facts f JOIN people p ON p.id = f.person_id
    WHERE p.conversation_id = ? AND f.person_id = ? AND f.status IN ('deleted', 'corrected')`).all(conversationId, personId)
    .some(r => factKey(r.fact) === key || r.fact === forgottenMark(personId, key));
}

/**
 * A fact the review found stale or contradicted by a later message, with no replacement. 'superseded'
 * rather than 'deleted': the person did not take it back, and a state that flips back can return.
 */
export function retireFact(conversationId, id, { at = clock.now() } = {}) {
  const row = getFact(conversationId, id);
  if (!row) return { ok: false, error: "not an active fact here" };
  db.prepare("UPDATE person_facts SET status = 'superseded', valid_to = ? WHERE id = ?").run(at, id);
  db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ? AND source_table = 'person_facts'").run(id);
  return { ok: true, was: row };
}

/** Point a fact's source at the message that justified it (the review's correction). */
export function setFactSources(conversationId, id, messageIds) {
  if (!getFact(conversationId, id)) return false;
  db.prepare("UPDATE person_facts SET source_message_ids = ? WHERE id = ?").run(JSON.stringify(messageIds), id);
  return true;
}

// Last, after every table exists.
// REASON_ENCRYPT_STRICT=1 (tests, shadow copies): SQLite itself refuses plaintext in a sealed column.
if (restcrypt.flagOn() && process.env.REASON_ENCRYPT_STRICT === "1") restcrypt.installStrictTriggers(db);
else restcrypt.dropStrictTriggers(db);
