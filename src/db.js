// Truth of state lives here, behind tools. The model may only claim what these functions returned.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config, clock } from "./config.js";
import { parseSheet, applyPatch, addSteer, emptySheet } from "./sheet.js";

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
addColumnIfMissing("calls", "profile", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("calls", "tts_model", "TEXT NOT NULL DEFAULT ''");
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
// The language a person's pages carry their top line in ("twi"), 2026-10-06. Empty is English.
addColumnIfMissing("accounts", "language", "TEXT NOT NULL DEFAULT ''");
// What a page is FOR, when it is one Reason keeps rather than one it made once (2026-10-06).
// `activity` is the only one so far: the page of everything open, which has to stay at the same
// link so a person can keep it rather than hunt for the newest of nine. NULL is every ordinary
// page and always will be — a role is claimed, never inferred. See pageWithRole.
addColumnIfMissing("pages", "role", "TEXT");
// Which job a timer, a watcher or a thing that really went out belongs to (2026-10-06). Written at
// the moment each one is made, which is the whole point: "forget the trip" has to be able to find
// everything running for the trip by LOOKING IT UP rather than by the model remembering what it
// started four hours and sixty trimmed messages ago. Null is an ordinary one that belongs to no
// job, and a row from before these columns reads as exactly that. See src/letgo.js.
addColumnIfMissing("timers", "task_id", "INTEGER");
addColumnIfMissing("watches", "task_id", "INTEGER");
addColumnIfMissing("action_ledger", "task_id", "INTEGER");
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
// Which way the phone rang (2026-10-06, with ElevenLabs). Every call before this one was placed by
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
// clinic at lunchtime is not a shop at 10am, and it is OUR clock because ElevenLabs has no hold
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
// A message that must not go out before another one has. A reply with a link in it leaves as two
// messages — the bare URL, then the words about it (src/links.js) — and "the summary arrived first"
// would be worse than either of them being late. The chain is enforced in dueOutbound and in the
// cascade inside markOutboundFailed, so it holds through a retry an hour later and through a
// restart, not just on the happy path.
addColumnIfMissing("outbox", "after_id", "INTEGER");
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
// The outcome sheet (2026-10-06): everything one task is carrying — the budget, the dates, the
// people, the options already turned down and why. On the task rather than in the model's context,
// because the context is trimmed to the last sixty messages and a task outlives that. A task from
// before this column reads as an empty sheet and goes on working exactly as it did. See src/sheet.js.
addColumnIfMissing("tasks", "sheet", "TEXT NOT NULL DEFAULT '{}'");
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
addColumnIfMissing("accounts", "notice_window_start", "INTEGER");
addColumnIfMissing("accounts", "notice_window_end", "INTEGER");
addColumnIfMissing("accounts", "notice_window_asked_at", "INTEGER");
addColumnIfMissing("accounts", "notice_window_answered_at", "INTEGER");
// Reason's contact card went to this person (src/contact.js). Once per account, ever; `tried_at`
// is what stops a failing line from meaning a card attempt on every text.
addColumnIfMissing("accounts", "contact_card_sent_at", "INTEGER");
addColumnIfMissing("accounts", "contact_card_tried_at", "INTEGER");
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
// Which standing check-in this firing belongs to (2026-10-07). NULL is every ordinary timer and
// always will be — a one-off reminder, a day-of nudge, a catch parked for later. A timer that
// carries one is one occurrence of a `series` row, and the series schedules the next after it. See
// src/series.js.
addColumnIfMissing("timers", "series_id", "INTEGER");

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
export function createTimer(conversationId, { fireAt, note, planId = null, taskId = null, seriesId = null }) {
  const r = db.prepare("INSERT INTO timers (conversation_id, fire_at, note, plan_id, task_id, series_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(conversationId, fireAt, note, planId, taskId, seriesId);
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
export function createSeries(conversationId, { what, rule, tz, nextAt = null }) {
  const r = db.prepare(`INSERT INTO series (conversation_id, what, rule, tz, next_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(conversationId, what, JSON.stringify(rule ?? {}), tz, nextAt, clock.now());
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
    db.prepare("UPDATE series SET state = 'ended', ended_at = ?, ended_why = ?, next_at = NULL, awaiting_since = NULL WHERE id = ?")
      .run(at, why === null ? null : String(why).slice(0, 300), id);
  } else {
    db.prepare("UPDATE series SET state = ? WHERE id = ?").run(state, id);
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
export function noteSeriesFired(id, { at = clock.now() } = {}) {
  db.prepare("UPDATE series SET fired_count = fired_count + 1, last_fired_at = ?, awaiting_since = ? WHERE id = ?")
    .run(at, at, id);
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
  if (!rows.length) return { ok: false, error: `Nothing is on record about '${about}'.` };

  const facts = [];
  for (const p of rows) {
    for (const f of personFacts(p.id)) facts.push(f.fact);
    db.prepare("DELETE FROM person_facts WHERE person_id = ?").run(p.id);
    db.prepare("DELETE FROM people WHERE id = ?").run(p.id);
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
    old_rows_removed: old.length,
    thread_lines_cleared: scrubbed,
    covers: "every fact saved about them, under that name and any longer name containing it, plus the copies of those facts in this thread. It does NOT delete their own messages to you — that is their conversation, not something you worked out.",
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

// ---------- confirmations ----------
export function askConfirmation({ conversationId, action, summary, stakes, target = "", askedAfterMsgs, taskId = null }) {
  const r = db.prepare(`INSERT INTO confirmations
    (conversation_id, action, summary, stakes, target, asked_at, asked_after_msgs, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, action, summary, stakes, target, clock.now(), askedAfterMsgs, taskId);
  return getConfirmation(conversationId, Number(r.lastInsertRowid));
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
  return db.prepare(`SELECT * FROM confirmations
    WHERE conversation_id = ? AND asked_at >= ?
      AND (task_id IS NULL OR task_id = ?)
      AND refused_at IS NULL AND consumed_at IS NULL
    ORDER BY asked_at`).all(conversationId, task.created_at, task.id);
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

// ---------- accounts: one Reason per person ----------
export function getAccount(conversationId) {
  return db.prepare("SELECT * FROM accounts WHERE conversation_id = ?").get(conversationId) ?? null;
}

export function accountByAddress(channel, address) {
  return db.prepare("SELECT * FROM accounts WHERE channel = ? AND address = ?").get(channel, address) ?? null;
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
  return db.prepare("SELECT * FROM accounts WHERE address = ? ORDER BY last_seen_at DESC LIMIT 1").get(addr) ?? null;
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

/** The language a person wants their pages' top line in ("twi"); "" puts it back to English. */
export function setAccountLanguage(conversationId, language) {
  const l = String(language ?? "").trim().toLowerCase().slice(0, 24);
  const r = db.prepare("UPDATE accounts SET language = ? WHERE conversation_id = ?").run(l, conversationId);
  return r.changes ? getAccount(conversationId) : null;
}

// ---------- the contact card (src/contact.js) ----------
export function markContactCardTried(conversationId) {
  db.prepare("UPDATE accounts SET contact_card_tried_at = ? WHERE conversation_id = ?").run(clock.now(), conversationId);
}

export function markContactCardSent(conversationId) {
  db.prepare("UPDATE accounts SET contact_card_sent_at = ? WHERE conversation_id = ?").run(clock.now(), conversationId);
}

/** Everybody who has an account and has not had the card. Oldest account first. */
export function accountsWithoutContactCard() {
  return db.prepare("SELECT * FROM accounts WHERE contact_card_sent_at IS NULL ORDER BY created_at ASC").all();
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

export function createTask(conversationId, { title, goal, wakeAt = null, maxAttempts, sheet = null }) {
  const now = clock.now();
  // The sheet is validated before the row exists, so a task never starts with a half-written one.
  const merged = applyPatch(emptySheet(), sheet, { now });
  if (!merged.ok) return merged;
  const r = db.prepare(`INSERT INTO tasks
    (conversation_id, title, goal, state, next_wake_at, max_attempts, sheet, created_at, updated_at)
    VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
    .run(conversationId, title, goal, wakeAt, maxAttempts, JSON.stringify(merged.sheet), now, now);
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
      .run(channel, externalId, conversationId, clock.now(), text ? String(text) : null,
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

/** The newest message this conversation is holding, or null. Read only — nothing is claimed. */
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
export function enqueueOutbound({ idemKey, conversationId, channel, address, chatId = null, body, media = null, sendStyle = null, replyTo = null, afterId = null, toOwner = false, maxAttempts = 5 }) {
  const existing = db.prepare("SELECT * FROM outbox WHERE idem_key = ?").get(idemKey);
  if (existing) return { fresh: false, row: rowToOut(existing) };
  const now = clock.now();
  const r = db.prepare(`INSERT INTO outbox
    (idem_key, conversation_id, channel, address, chat_id, body, media, send_style, reply_to, after_id, state, max_attempts, next_attempt_at, to_owner, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
    .run(idemKey, conversationId, channel, address, chatId, String(body ?? ""),
      media ? JSON.stringify(media) : null, sendStyle, replyTo, afterId, maxAttempts, now, toOwner ? 1 : 0, now, now);
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
    markOutboundFailed(r.id, { error: `the message it goes with never arrived, so this was not sent on its own: ${String(error ?? "")}` });
  }
  return getOutbound(id);
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
           OR EXISTS (SELECT 1 FROM outbox AS p WHERE p.id = o.after_id AND p.state = 'sent'))
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
  // personalization webhook (src/calls/inbound.js), which makes the row while the phone is still
  // ringing so that the turn behind the voice has something to be scoped by.
  direction = "out",
  // An inbound call has an id from the platform before Reason knows anything else about it, and
  // that id is the only thing the custom-LLM endpoint can look the call up by.
  externalId = null,
  // An inbound call reached the state it is in by being answered, not by being dialled.
  state = "placing",
  // The job this call is a step of, when it is one.
  taskId = null,
} = {}) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO calls
    (conversation_id, provider, external_id, to_number, is_owner, goal, facts, state, direction,
     confirmation_id, announcement, webhook_token, task_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, provider, externalId, toNumber, isOwner ? 1 : 0, goal, JSON.stringify(facts ?? []),
         state, direction === "in" ? "in" : "out", confirmationId,
         announcement, linkToken(CALL_WEBHOOK_TOKEN_LENGTH), taskId, now, now);
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

export function listCalls(conversationId, { limit = 20 } = {}) {
  return db.prepare("SELECT * FROM calls WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(conversationId, limit).map(r => ({ ...r, facts: JSON.parse(r.facts) }));
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

/** Calls on this errand that are still going, for the parallel limit. */
export function liveErrandCalls(conversationId, errandId) {
  return db.prepare("SELECT * FROM calls WHERE conversation_id = ? AND errand_id = ? AND state IN ('placing','ringing','in_progress')")
    .all(conversationId, errandId).map(r => ({ ...r, facts: safeJson(r.facts, []) }));
}

/** Every attempt at one number on one errand, for the retry limit and the no-second-voicemail rule. */
export function callsToNumber(conversationId, { errandId = null, toNumber = "" } = {}) {
  const sql = errandId
    ? "SELECT * FROM calls WHERE conversation_id = ? AND to_number = ? AND errand_id = ? ORDER BY id ASC"
    : "SELECT * FROM calls WHERE conversation_id = ? AND to_number = ? ORDER BY id ASC";
  const args = errandId ? [conversationId, toNumber, errandId] : [conversationId, toNumber];
  return db.prepare(sql).all(...args).map(r => ({ ...r, facts: safeJson(r.facts, []) }));
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
    .run(errandId, callId, conversationId, place, toNumber, priceCents, feesCents, totalCents,
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
    WHERE c.conversation_id = ? AND k.to_number = ? ORDER BY c.id ASC`)
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
    .run(conversationId, askedOnCallId, taskId, toNumber, name, goal, JSON.stringify(brief ?? {}),
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
    ? db.prepare(`SELECT * FROM call_requests WHERE conversation_id = ? AND to_number = ? AND state IN (${marks}) ORDER BY id DESC`)
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
    "verified_at", "verified_how", "verify_tries", "verify_sent_at", "verify_sent_after_msgs",
    "profile", "tts_model",
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
export function createWatch(conversationId, { url, lookingFor, note = "", everyMs, planId = null, taskId = null }) {
  const r = db.prepare(`INSERT INTO watches
    (conversation_id, url, looking_for, note, every_ms, plan_id, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, url, lookingFor, note, everyMs, planId, clock.now(), taskId);
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

export function createPage(conversationId, { title, blocks, subtitle = null, closing = null }) {
  const now = clock.now();
  const id = pageId();
  db.prepare(`INSERT INTO pages (id, conversation_id, title, content, shared, revision, created_at, updated_at, owner_key, subtitle, closing)
    VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?)`)
    .run(id, conversationId, title, JSON.stringify(blocks), now, now, pageKey(), subtitle || null, closing || null);
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
    .run(title ?? page.title, JSON.stringify(blocks ?? page.blocks), sub, close, clock.now(), id);
  return getPage(id);
}

export function setPageShared(conversationId, id, shared) {
  const page = getPageIn(conversationId, id);
  if (!page) return null;
  db.prepare("UPDATE pages SET shared = ?, updated_at = ? WHERE id = ?").run(shared ? 1 : 0, clock.now(), id);
  return getPage(id);
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
    .run(id, conversationId, kind, title, subtitle || null, closing || null, JSON.stringify(blocks),
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
    niche: r.niche || "", niche_searches: r.niche_searches ?? 0,
    enough_at: r.enough_at ?? null, enough_why: r.enough_why || "",
    created_at: r.created_at, updated_at: r.updated_at, finished_at: r.finished_at ?? null,
  };
}

export function createResearch(conversationId, { question, queries = [], taskId = null, niche = "" }) {
  const now = clock.now();
  const r = db.prepare(`INSERT INTO research (conversation_id, question, task_id, queries, niche, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(conversationId, question, taskId, JSON.stringify(queries), String(niche ?? ""), now, now);
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
export const oauthPerAccountMigration = migrateOauthTokensPerAccount();

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
 * A probe that comes back anything but `signed_in` revokes the live row, so `liveAccount` (and
 * therefore every status anybody reads) stops saying connected the moment the site stops agreeing.
 * The row is kept with its state and evidence, so "why does it think I am signed out" is answerable.
 */
export function recordSiteSignin(conversationId, site, { state, evidence = "", scopes = ["signed_in"] }) {
  const now = clock.now();
  const row = liveAccount(conversationId, site);
  if (state === "signed_in") {
    if (row) {
      db.prepare("UPDATE connected_accounts SET state = ?, evidence = ?, checked_at = ? WHERE id = ?")
        .run(state, evidence, now, row.id);
      return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(row.id);
    }
    const r = db.prepare(`INSERT INTO connected_accounts (conversation_id, name, scopes, connected_at, state, evidence, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(conversationId, site, JSON.stringify(scopes), now, state, evidence, now);
    return db.prepare("SELECT * FROM connected_accounts WHERE id = ?").get(Number(r.lastInsertRowid));
  }
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
      .run(accessToken, refreshToken, refreshToken, scope, expiresAt, label, label, now, existing.id);
    return db.prepare("SELECT * FROM oauth_tokens WHERE id = ?").get(existing.id);
  }
  db.prepare(`INSERT INTO oauth_tokens (conversation_id, provider, access_token, refresh_token, scope, expires_at, account_label, connected_at, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, provider, accessToken, refreshToken, scope, expiresAt, label, now, now);
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
    return db.prepare("SELECT * FROM oauth_tokens WHERE conversation_id = ? AND provider = ? AND LOWER(account_label) = LOWER(?)")
      .get(conversationId, provider, String(account)) ?? null;
  }
  const rows = listOauthTokens(conversationId, provider);
  if (rows.length <= 1) return rows[0] ?? null;
  return rows.find(r => r.is_default) ?? rows[0];
}

/** Every grant this person has with this provider, oldest first so "their first one" is stable. */
export function listOauthTokens(conversationId, provider) {
  return db.prepare("SELECT * FROM oauth_tokens WHERE conversation_id = ? AND provider = ? ORDER BY connected_at ASC, id ASC")
    .all(conversationId, provider);
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

export function newOauthState({ conversationId, provider, scope = "", redirectUri = "" }) {
  const state = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO oauth_states (state, conversation_id, provider, scope, redirect_uri, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(state, conversationId, provider, scope, redirectUri, clock.now());
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

export function clearOauthStates(conversationId, provider) {
  return Number(db.prepare("DELETE FROM oauth_states WHERE conversation_id = ? AND provider = ?").run(conversationId, provider).changes);
}

// ---------- spend ----------
export function spentToday(conversationId, day) {
  const row = db.prepare("SELECT COALESCE(SUM(cents), 0) AS cents, COUNT(*) AS n FROM spend WHERE conversation_id = ? AND day = ?")
    .get(conversationId, day);
  return { cents: Number(row?.cents ?? 0), count: Number(row?.n ?? 0) };
}

export function recordSpend({ conversationId, day, cents, what = "", site = "", confirmationId = null }) {
  const r = db.prepare("INSERT INTO spend (conversation_id, day, cents, what, site, confirmation_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(conversationId, day, Math.round(cents), what, site, confirmationId, clock.now());
  return Number(r.lastInsertRowid);
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

/** The job whose question the master is being asked right now, if there is one. */
export function remoteJobAwaitingAnswer(conversationId) {
  return rowToJob(db.prepare(`SELECT * FROM remote_jobs WHERE conversation_id = ? AND state = 'needs_you'
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
  const row = db.prepare("SELECT COALESCE(SUM(cents), 0) AS cents, COUNT(*) AS n FROM spend WHERE conversation_id = ? AND substr(day, 1, 7) = ?")
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

// ---------- Stripe: a saved card and what it has been charged ----------
//
// Reason never sees a card number. Stripe Checkout collects it and hands back a customer id and a
// payment method id, which is the whole of what `stripe_customers` holds — one row per conversation,
// the same way `spend_caps` is one row per conversation. `stripe_charges` is the local half of every
// charge attempt, success or not; the cap and ledger logic in src/trust.js reads the existing `spend`
// table for the numbers, and this table is the Stripe-specific receipt (payment intent id, status)
// that `payment_history` reads back.
db.exec(`
  CREATE TABLE IF NOT EXISTS stripe_customers (
    conversation_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    payment_method_id TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    last4 TEXT NOT NULL DEFAULT '',
    setup_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stripe_charges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    description TEXT NOT NULL DEFAULT '',
    stripe_payment_intent_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    confirmation_id INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS stripe_charges_by_conv ON stripe_charges (conversation_id, created_at);
`);

export function upsertStripeCustomer({ conversationId, customerId, paymentMethodId, brand = "", last4 = "" }) {
  db.prepare(`INSERT INTO stripe_customers (conversation_id, customer_id, payment_method_id, brand, last4, setup_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      customer_id = excluded.customer_id,
      payment_method_id = excluded.payment_method_id,
      brand = excluded.brand,
      last4 = excluded.last4,
      setup_at = excluded.setup_at`)
    .run(conversationId, customerId, paymentMethodId, brand, last4, clock.now());
  return getStripeCustomer(conversationId);
}

export function getStripeCustomer(conversationId) {
  return db.prepare("SELECT * FROM stripe_customers WHERE conversation_id = ?").get(conversationId) ?? null;
}

export function recordStripeCharge({ conversationId, amountCents, currency = "usd", description = "", stripePaymentIntentId = "", status, confirmationId = null }) {
  const r = db.prepare(`INSERT INTO stripe_charges
      (conversation_id, amount_cents, currency, description, stripe_payment_intent_id, status, confirmation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, Math.round(amountCents), currency, description, stripePaymentIntentId, status, confirmationId, clock.now());
  return Number(r.lastInsertRowid);
}

export function listStripeCharges(conversationId, limit = 20) {
  return db.prepare("SELECT * FROM stripe_charges WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(conversationId, limit);
}

// ---------- Stripe Issuing: virtual cards for merchant checkout ----------
//
// A cardholder is created once per conversation, then virtual cards are minted per purchase with a
// per-authorization spending limit equal to the checkout total. The card number/exp/cvc is retrieved
// via Stripe's expand parameter and typed into the checkout form by the browser tools — the person
// never enters card details. The card is effectively single-use: its spending cap prevents a second
// charge, and it can be canceled after the purchase settles.
db.exec(`
  CREATE TABLE IF NOT EXISTS issuing_cardholders (
    conversation_id TEXT PRIMARY KEY,
    cardholder_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS issuing_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    card_id TEXT NOT NULL UNIQUE,
    amount_limit_cents INTEGER NOT NULL,
    merchant TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    canceled_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS issuing_cards_by_conv ON issuing_cards (conversation_id, created_at);
`);

export function upsertIssuingCardholder({ conversationId, cardholderId }) {
  db.prepare(`INSERT INTO issuing_cardholders (conversation_id, cardholder_id, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      cardholder_id = excluded.cardholder_id,
      created_at = excluded.created_at`)
    .run(conversationId, cardholderId, clock.now());
}

export function getIssuingCardholder(conversationId) {
  return db.prepare("SELECT * FROM issuing_cardholders WHERE conversation_id = ?").get(conversationId) ?? null;
}

export function recordIssuingCard({ conversationId, cardId, amountLimitCents, merchant = "", description = "" }) {
  db.prepare(`INSERT INTO issuing_cards (conversation_id, card_id, amount_limit_cents, merchant, description, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)`)
    .run(conversationId, cardId, Math.round(amountLimitCents), merchant, description, clock.now());
}

export function cancelIssuingCard(cardId) {
  db.prepare("UPDATE issuing_cards SET status = 'canceled', canceled_at = ? WHERE card_id = ?")
    .run(clock.now(), cardId);
}

export function listIssuingCards(conversationId, limit = 20) {
  return db.prepare("SELECT * FROM issuing_cards WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
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
      String(e.end ?? ""), String(e.status ?? ""), JSON.stringify(e.attendees ?? []), String(e.time_zone ?? ""), at);
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
  thing = "", account = "", threadId = "", eventId = "", state = "", source = "",
}) {
  const existing = db.prepare("SELECT * FROM notice_seen WHERE conversation_id = ? AND kind = ? AND key = ?")
    .get(conversationId, kind, String(key));
  if (existing) return { ...existing, fresh: false };
  db.prepare(`INSERT INTO notice_seen
      (conversation_id, kind, key, what, detail, moment_at, first_seen, urgent, thing, account, thread_id, event_id, state, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, kind, String(key), what, detail, momentAt, at, urgent ? 1 : 0,
      String(thing || key), account, threadId, eventId, String(state ?? ""), String(source ?? "").slice(0, 400));
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

/** Their digest went out for this local day. Keyed by the day so a late pass is still that day's. */
export function markDigestDay(conversationId, day) {
  noticeSweep(conversationId);
  db.prepare("UPDATE notice_sweeps SET last_digest_day = ? WHERE conversation_id = ?").run(String(day), conversationId);
  return noticeSweep(conversationId);
}

/** Things still true, never said, oldest first. What the next sweep raises and the next reply folds in. */
export function heldNotices(conversationId, { limit = 5 } = {}) {
  return db.prepare(`SELECT * FROM notice_seen WHERE conversation_id = ? AND said_at IS NULL AND claimed_at IS NULL
    AND held_at IS NOT NULL AND timer_id IS NULL AND resolved_at IS NULL AND dropped_at IS NULL
    ORDER BY urgent DESC, first_seen ASC LIMIT ?`)
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
      notice_tz, notice_window_start, notice_window_end, notice_window_asked_at, notice_window_answered_at
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
      .run(String(who).trim(), why ? String(why).trim() : existing.why, JSON.stringify(contacts), existing.id);
    return { ...getImportantPerson(conversationId, key), already_there: true };
  }
  db.prepare("INSERT INTO important_people (conversation_id, who, who_key, why, contacts, added_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(conversationId, String(who).trim(), key, String(why ?? "").trim(), JSON.stringify(contacts), clock.now());
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
  const before = db.prepare("SELECT * FROM preferences WHERE conversation_id = ? AND words = ? AND turned_down = ?")
    .get(conversationId, clean, down);
  if (before) return { ...before, already_knew: true };
  const r = db.prepare(`INSERT INTO preferences (conversation_id, category, words, note, turned_down, task_id, learned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, cat, clean, String(note ?? "").trim(), down, taskId, clock.now());
  return { ...getPreference(conversationId, Number(r.lastInsertRowid)), already_knew: false };
}

export function getPreference(conversationId, id) {
  return db.prepare("SELECT * FROM preferences WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
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
    args.push(clean);
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

/** Where a guess came from. Both are things `remember` refuses to save as facts. */
export const GUESS_SOURCES = ["i_worked_it_out", "i_saw_it_in_a_photo"];

/** Note one, or hand back the one already there. The same guess twice is one guess. */
export function noteGuess(conversationId, { about, guess, how = "i_worked_it_out" } = {}) {
  const who = String(about ?? "").trim();
  const what = String(guess ?? "").trim();
  if (!who || !what) return null;
  const source = GUESS_SOURCES.includes(how) ? how : "i_worked_it_out";
  const before = db.prepare("SELECT * FROM guesses WHERE conversation_id = ? AND about = ? AND guess = ?")
    .get(conversationId, who, what);
  if (before) return { ...before, already_guessed: true };
  const r = db.prepare("INSERT INTO guesses (conversation_id, about, guess, how, noted_at) VALUES (?, ?, ?, ?, ?)")
    .run(conversationId, who, what, source, clock.now());
  return { ...getGuess(conversationId, Number(r.lastInsertRowid)), already_guessed: false };
}

export function getGuess(conversationId, id) {
  return db.prepare("SELECT * FROM guesses WHERE id = ? AND conversation_id = ?").get(id, conversationId) ?? null;
}

/** The ones still guesses. A confirmed one is a fact now and belongs in the facts section. */
export function listGuesses(conversationId, { includeConfirmed = false, limit = 40 } = {}) {
  const sql = includeConfirmed
    ? "SELECT * FROM guesses WHERE conversation_id = ? ORDER BY noted_at DESC, id DESC LIMIT ?"
    : "SELECT * FROM guesses WHERE conversation_id = ? AND confirmed_at IS NULL ORDER BY noted_at DESC, id DESC LIMIT ?";
  return db.prepare(sql).all(conversationId, limit);
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
  const row = db.prepare(`SELECT * FROM guesses WHERE conversation_id = ? AND about = ? AND guess = ?
    AND confirmed_at IS NULL`).get(conversationId, String(about ?? "").trim(), String(guess ?? "").trim());
  if (!row) return null;
  db.prepare("UPDATE guesses SET confirmed_at = ?, confirmed_said = ? WHERE id = ?")
    .run(clock.now(), String(said ?? "").trim(), row.id);
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
    args.push(clean);
  }
  db.prepare(`UPDATE guesses SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  return { ok: true, was: row, guess: getGuess(conversationId, id) };
}

/** Gone, really: a guess somebody has corrected should not sit on disk being wrong. */
export function dropGuess(conversationId, id) {
  const row = getGuess(conversationId, id);
  if (!row) return { ok: false, error: `There is no guess #${id} here.` };
  db.prepare("DELETE FROM guesses WHERE id = ?").run(id);
  return { ok: true, was: row };
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
  const before = db.prepare(`SELECT * FROM whys WHERE conversation_id = ? AND about = ? AND why = ?
    AND superseded_at IS NULL`).get(conversationId, subject, goal);
  if (before) return { ...before, already_knew: true };
  const r = db.prepare(`INSERT INTO whys (conversation_id, about, why, said, task_id, stated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(conversationId, subject, goal, words, taskId, clock.now());
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
    VALUES (?, ?, ?, ?, ?, ?)`).run(conversationId, row.about, goal, words, row.task_id, now);
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
  return db.prepare(`SELECT f.id, f.fact, f.created_at, p.name AS about, p.id AS person_id
    FROM person_facts f JOIN people p ON p.id = f.person_id
    WHERE f.id = ? AND p.conversation_id = ?`).get(id, conversationId) ?? null;
}

/** Every fact on record with its id and its subject, newest subject first. The page's first section. */
export function listFacts(conversationId, { limit = 60 } = {}) {
  return db.prepare(`SELECT f.id, f.fact, f.created_at, p.name AS about
    FROM person_facts f JOIN people p ON p.id = f.person_id
    WHERE p.conversation_id = ?
    ORDER BY p.updated_at DESC, p.id, f.created_at LIMIT ?`).all(conversationId, limit);
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
  const clash = db.prepare("SELECT id FROM person_facts WHERE person_id = ? AND fact = ? AND id != ?")
    .get(row.person_id, clean, id);
  if (clash) {
    return {
      ok: false,
      error: `'${clean}' is already saved about ${row.about} as #${clash.id}. Correcting this one into it would leave two`
        + ` rows saying the same thing and then quietly lose one. Drop #${id} instead if it is simply wrong.`,
    };
  }
  db.prepare("UPDATE person_facts SET fact = ? WHERE id = ?").run(clean, id);
  db.prepare("UPDATE people SET updated_at = ? WHERE id = ?").run(clock.now(), row.person_id);
  return { ok: true, was: row, fact: getFact(conversationId, id) };
}

/** One fact gone. The subject stays: forgetting one thing about somebody is not forgetting them. */
export function dropFact(conversationId, id) {
  const row = getFact(conversationId, id);
  if (!row) return { ok: false, error: `There is no saved fact #${id} here.` };
  db.prepare("DELETE FROM person_facts WHERE id = ?").run(id);
  return { ok: true, was: row };
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
