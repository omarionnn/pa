// Your data, in one command.
//   npm run data:export                  everything, as JSON, to stdout
//   npm run data:export -- dm:owner      one conversation only
//   npm run data:export -- --no-audio    skip the call recordings' bytes (they are the big part)
//   npm run data:export -- --no-files    skip the documents' bytes, keeping the list of them
//   npm run data:delete -- --yes             wipe everything, recordings included
//   npm run data:delete -- dm:owner --yes    wipe one conversation
//
// Deletion is real and immediate. It refuses to run without --yes.
//
// This is the whole of somebody's data on demand. The other half of the promise is on a clock:
// src/privacy.js drops content after REASON_KEEP_CONTENT_DAYS and the records of it after
// REASON_KEEP_RECORDS_DAYS, on every sweep, without anybody asking. Anything added to a table
// here belongs in one of those two windows as well, or it is kept forever by accident.
//
// Call recordings are audio files on disk rather than rows, so they are handled explicitly at
// both ends: an export carries the bytes inside it, base64, with the checksum, so the export is a
// complete copy somebody could walk away with; and a delete unlinks the files as well as the
// rows. A delete that left the audio sitting in data/recordings/ would be exactly the kind of
// half-kept promise this file exists to avoid.
//
// Documents — a .docx, a .pptx, a .pdf Reason wrote and sent somebody — are the same shape of thing
// and are handled the same way, at both ends. They are MORE somebody's own data than a recording
// is: a document is their letter, their draft, their plan, written at their request. An export that
// listed them without the bytes would not be a copy of their data, and a delete that left them in
// data/documents/ would leave Reason's own files of somebody's writing on a disk they thought they
// had cleared.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { db, recordingFiles, documentFiles, rawPrepare, restcrypt } from "./db.js";
import { config } from "./config.js";
// Creates stranger_calls if this runs before anything else has (npm run data:*).
import "./strangercalls.js";
import "./tooldiet.js";
import "./websetupstore.js"; // web_setups + the websetup_owner() SQL function CHILD_SCOPE uses
import { profilePath } from "./browser.js";
import { readRecording, deleteRecordingFile, mimeFor } from "./calls/recordings.js";
import { readDocument, deleteDocumentFile, mimeForKind } from "./documents/store.js";
import * as google from "./google.js";

const TABLES = [
  "conversations", "plans", "timers", "memories", "people", "person_facts",
  "action_ledger", "confirmations", "tasks", "nudges", "threads", "calls", "watches",
  "pages", "page_choices", "seen_urls", "connected_accounts", "accounts", "usage",
  // How each of their calls went, turn by turn: timings and tool names, no words. Keyed by
  // conversation like the call rows they belong to, so a delete takes them with the calls.
  "call_turns",
 // A call they made to Reason's number before they were a user (src/strangercalls.js), once it has
 // been matched to them by their own number. Unmatched rows are nobody's account and age out by the
 // retention setting; a full delete takes them too.
 "stranger_calls",
  // The documents Reason wrote for them. The row carries the title and the blocks it was built
  // from, which is their own writing; the files themselves are carried separately, below, the same
  // way the recordings are.
  "documents",
  // Which files on disk were made for them (src/ownfiles.js): paths only, no bytes.
  "conversation_files",
  // Which new features this person has been told about. Theirs like anything else keyed by
  // conversation, and a delete has to take it: leaving it behind would mean a person who wiped
  // their Reason and came back got told nothing was new.
  "whats_new_told",
  // Everything they sent that was not words, and what was got out of it. The filenames of
  // somebody's photos and the links they pasted are as much theirs as any message, so this is in
  // an export and a delete takes it.
  "media_items",
  // What a day cost, and the OAuth grants. Both are somebody's own record of what Reason did for
  // them, so both belong in an export and a delete — but see SECRET_TABLES: the token values do not
  // leave the machine.
  "spend", "oauth_tokens",
  // The things they told Reason it may do without asking, in their own words. Their sentence and
  // their decision, so it is in an export like anything else they said — and a delete has to take
  // it, because a permission left behind after somebody wipes their Reason is permission nobody
  // remembers giving.
  "permissions",
  // The two spending limits they set, and any commit whose outcome nobody ever established. Both are
  // their own record: the first is a decision they made, the second is the evidence for "you told me
  // you didn't know whether that went through". A delete takes both.
  "spend_caps", "unknown_outcomes",
  // The people they said Reason may write to but never send to. Their list and their reasons.
  "important_people",
  // A to-do list they sent and the plan made of it, with the words of their approval (src/todo.js).
  "todo_lists", "todo_items",
  // What they turned down and why, in their own words. As much theirs as a memory or a permission —
  // every row quotes a sentence they said — so it is in an export, and a delete has to take it or
  // somebody who wiped their Reason and came back would be offered around a taste they thought they
  // had deleted.
  "preferences",
  // What Reason is GUESSING about them, kept as a guess so they can see and correct it. Its own
  // reading rather than their words, which makes it no less theirs: it is a row about them that
  // shapes what Reason says. An export that left it out would hide the part of the record a person
  // most wants to check, and a delete that left it behind would leave a stale guess on disk.
  "guesses",
  // Why they said they are doing things, in their own words, including the reasons they have since
  // replaced. Theirs twice over: every row quotes a sentence they said, and it is the row that
  // decides what Reason puts in front of them first. An export without it would hide the thing most
  // worth checking, and a delete that left it behind would leave Reason still ranking by a goal
  // somebody thought they had deleted.
  "whys",
  // Everything below here was missing until the privacy pass, and every one of them holds
  // somebody's own words or links. An export that left them out was not a copy of their data, and
  // a delete that left them behind was not a delete.
  //
  // What arrived: one row per message with its text, one per part of a message with the links and
  // attachments on it, and anything still held waiting for the rest of a burst.
  "inbound_messages", "inbound_parts", "pending_inbound",
  // What went out, including the body of every message Reason sent them and anything still queued.
  "outbox",
  // A research run, its queries, and what each source said. The two children hang off `research`.
  "research", "research_queries", "research_sources",
  // Each step a durable task took, which is Reason narrating their errand back to them.
  "task_log",
  // Cached transcripts of videos, keyed by the video rather than by the person. A scoped export
  // takes the ones for videos that conversation sent or Reason looked up for it; a scoped delete
  // drops those rows outright. They are a cache — the cost of deleting one somebody else also
  // sent is a re-fetch, and the cost of keeping it is a transcript of what they watched.
  "video_accounts",
  // Work handed to the builders on this machine. The row holds the master's own words asking for
  // it and the brief written from them, so it is his content like any plan or message: an export
  // that left it out would not be a copy of his data and a delete that left it behind would not be
  // a delete. `remote_events` is every step a builder wrote down about it and is scoped through its
  // parent (see CHILD_SCOPE); the run directories on disk go in `deleteData`.
  "remote_jobs", "remote_events",
  // Noticing things first. Every one of these is about them: what their next two days looked like
  // at the last sweep, every thing Reason thought was worth raising and whether it really said it,
  // what today's interruptions have cost them, and where the sweep got to. `notice_events` holds
  // their event titles outright, so an export that left it out would not be a copy of their data —
  // and a delete that left any of them behind would mean somebody who wiped their Reason and came
  // back got yesterday's news as though it were new, off a row they thought they had deleted.
  "notice_events", "notice_seen", "notice_budget", "notice_sweeps",
  // What somebody is paying for every month, and what came of each cancellation. Theirs as much as
  // any plan: it is a list of their own money, read off their own receipts, with the confirmation
  // numbers a service gave them. An export without it would not be a copy of their data, and a
  // delete that left it behind would leave Reason still able to say what they subscribe to.
  "subscriptions",
  // Flight bookings: the purchase rows (what was priced, approved and placed for them), the
  // passengers they saved, and the e-ticket watch (ticket numbers and record locator read off their
  // own mail). Theirs, so in an export and taken by a delete. The passenger details themselves are
  // sealed and stay out of the file — see SECRET_COLUMNS.
  "agentcard_purchases", "flight_travelers", "flight_ticket_watch",
  // Standing check-ins. The row holds what Reason agreed to keep asking about and, in `last_report`,
  // the last thing they said back to it — their own words, so an export without it would not be a copy
  // of their data, and a delete that left it behind would leave Reason still asking every Monday about
  // a job search belonging to somebody who wiped their Reason. The firings are `timers` rows, above.
  "series",
  // What they said they do on a schedule, and whether they showed up. Both hold their own sentences
  // — the commitment quotes the words they set it in, the log quotes what they said about each
  // session — and the log holds what their own body did, which is about as personal as anything in
  // this file. An export without them would not be a copy of their data; a delete that left them
  // behind would leave Reason still able to nudge somebody who wiped it, off a schedule they thought
  // they had deleted.
  "commitments", "commitment_logs",
  // Something they are trying to do, and everything the standing search for it has turned up. The
  // goal row holds the sentence they said it in and the criteria in their own words; the matches
  // hold what Reason went and found for them. An export without them would not be a copy of their
  // data, and a delete that left them behind would leave Reason still texting job listings every
  // morning to somebody who wiped it, off criteria they thought they had deleted. The firings are
  // `series` and `timers` rows, above.
  "goals", "goal_matches",
  // The flights they are on, with the confirmation code, the passenger name, the seat and the
  // boarding pass. Among the most personal rows in here — where somebody will be, and when — so an
  // export without it would not be a copy of their data, and a delete that left it behind would
  // leave Reason still able to say where they are flying and still holding the code that opens the
  // booking.
  "flights",
  // The flight searches they asked for (src/flightsearch.js): the route, the dates, who is
  // travelling and what came back. Where somebody wants to go and when is theirs like the flights.
  "flight_searches",
  // Their invite links, how many invites they have left, and any request for more with the reason
  // they gave. Keyed by the inviter's conversation; a link a friend redeemed stays the inviter's row.
  "invites", "invite_allowances", "invite_requests",
  // Reason Web's thread (src/settle.js): which of their messages belong to which task, and the kind
  // of device each Web message was typed on. About them and their conversation, so exported and deleted.
  "task_messages", "web_devices",
  // The walks Reason made for them (src/trips.js): where from, where to, and the streets between.
  // Where somebody walks from is as personal as anything here, so exported and deleted.
  "trips",
  // Everything below was missing until the delete audit of 2026-11-07 (lead 14): tables made in
  // later parts of src/db.js and in modules that make their own. A delete left all of it behind
  // under a conversation id that is deterministic (dm:<channel>:<addr>), so re-admitting the same
  // number handed it straight back. test/data-coverage.test.js now fails the suite when any table
  // is in none of the lists in this file, so this cannot drift again.
  //
  // Reason Web's thread and its chats, the message log the memory graph is built from, the queue of
  // turns still to extract, the graph itself and the profile blocks summarising it.
  "messages", "web_chats", "event_log", "extraction_queue", "profile_blocks",
  // Their how-to-treat-me rules and the nightly memory review's watermark and per-pass cost (src/dream.js).
  "treat_rules", "memory_reviews", "memory_review_passes",
  // Which tools they use, by name, for the tool diet's likely set (src/tooldiet.js).
  "tool_recent", "tool_sets",
  "graph_entities", "graph_edges", "graph_mentions", "graph_merge_candidates",
  // Places they saved and the things they pinned on their Saved page.
  "saved_places", "saved_marks",
  // Paying: the AgentCard link (tokens sealed out of an export, see SECRET_COLUMNS), the saved card
  // and shopping profile, the stores they connected, the checkout runs and links, what each payment
  // asked, the shipping address, the Face ID passkeys and their approvals, and the daily cap with
  // every change to it. A card or a passkey left behind would let a later holder of the same
  // conversation id pay with it.
  "agentcard_users", "shop_profiles", "shop_cards", "shop_stores", "shop_runs", "shop_run_asks", "shop_links",
  "shop_payments", "shop_shipping", "pay_passkeys", "pay_approvals", "pay_approval_log",
  "daily_caps", "cap_changes", "offers", "uber_rides", "spotify_join_requests",
  // The Crossmint user a card saved on the web setup was saved under (src/shopconnect.js adoptSetupCard).
  "shop_crossmint_subjects",
  // Their no to "want me to use your Google login?", held 30 days per provider (src/socialsignin.js).
  "social_declines",
  // The daily edition and their stamps (src/daily.js, src/stamps.js).
  "daily_editions", "daily_looks", "daily_questions", "stamps", "stamp_shares", "stamp_jobs", "stamp_step_times",
  // Calls made on their behalf: the errands, quotes, commitments and requests to call somebody.
  "call_errands", "call_quotes", "call_commitments", "call_requests",
  // What they asked, what Reason claimed back, and the bookkeeping around it.
  "requests", "request_messages", "open_questions", "sent_claims", "choice_sets", "held_actions",
  "capability_misses", "parallel_runs", "pattern_asks", "line_change_cards",
  // Their own lists: what they spent, what they ate, what they need from the shop.
  "expenses", "meal_entries", "grocery_items",
  // Their side of an event: attendance, check-in, deliveries, the photos they added (the files go
  // too, in deleteData), the album note they agreed to, the claim a join page made for them, and
  // their ride offers, asks and the matches made of them. The event itself, when they organised it,
  // is shared with its guests: see KEPT_ON_DELETE.
  "event_attendees", "event_checkins", "event_deliveries", "event_photos", "album_consents", "event_claims", "web_setups",
  "ride_offers", "ride_asks", "ride_matches",
  // What an organiser scheduled for their guests (src/eventschedule.js): their own words, waiting to
  // go, and the record of which reminders went. Deleted, a waiting message never goes.
  "event_scheduled",
  // Which of their calls, messages and actions they asked Reason to forget, so recall never reads
  // them again (src/db.js forgetFromRecall). Row ids only, theirs.
  "recall_forgotten",
  // Exchanges a forget asked recall to index again without the forgotten line (src/recallindex.js).
  // Row ids only, theirs.
  "recall_reindex",
];

/**
 * Tables holding a conversation id that a scoped delete deliberately leaves, and why. Each is a
 * product decision rather than an oversight, raised as a question on the PR that made this list
 * (lead 14). A delete of the whole install takes them too.
 */
export const KEPT_ON_DELETE = {
  // Stripe customer and subscription ids, paid-until, and the trial's session count. Deleting it
  // would let anybody delete their data and start a fresh free trial on the same number.
  plan: "billing and trial record (Stripe ids, sessions used); deleting it restarts the free trial",
  harm_events: "abuse record: what the harm screen stopped; deleting it resets the screen's history",
  // Keyed by actor, which is not always a conversation: the password rate limit itself.
  event_join_attempts: "rate limit on event passwords; deleting it resets the guess counter",
  // A block protects the OTHER person in the pair, so it outlives this one's data.
  ride_blocks: "safety record that protects the other person in the pair",
  // An event they organised is shared with every guest, and so are its album and its messages.
  events: "shared with the event's guests; an organiser's delete would remove it for everyone",
  event_albums: "one per event, shared with every guest who contributed",
  event_messages: "an event's blasts, shared with every guest",
};

/**
 * Install-wide tables: no person's key on them, the operator's own records and caches. Listed so the
 * coverage test can tell "nobody's" from "forgotten". A whole-install delete leaves them, as before.
 */
export const INSTALL_WIDE = {
  agentcard_events: "AgentCard webhook log: order ids and statuses, no person",
  channel_limits: "what each channel refused, learned once for everyone",
  flight_provider_usage: "monthly search counts per flight provider",
  // `last_addr` is the number the last failure was about, so a fix can tell which one cleared.
  incidents: "the operator's failure log; last_addr names the number it was about",
  model_usage: "token and cost counts per feature, no person",
  ops_checks: "health checks",
  ops_digest: "the operator's digest lines",
  ops_state: "operator state; the one per-person key in it is removed by deleteData",
  place_photos: "photo cache by place",
  provider_calls: "per-provider call counts",
  provider_calls_hourly: "per-provider call counts",
  provider_state: "per-provider health",
  schema_meta: "schema version",
  shop_sites: "store directory",
  sqlite_sequence: "SQLite's own",
  stripe_events: "Stripe webhook dedupe log",
  subscription_usage: "Reason's own model-plan usage",
};

/**
 * Tables whose rows ARE credentials rather than content.
 *
 * `oauth_tokens` holds a Spotify access and refresh token, and anybody holding the refresh token
 * can act as that person on Spotify for the next six months. An export is a file that gets
 * emailed, dropped in a folder, pasted into a ticket — so these rows go out with the token values
 * replaced by a marker. What is kept is the part that is genuinely somebody's own record: which
 * provider, which scopes, when it was connected, when it was last renewed. A delete still deletes
 * the real thing.
 *
 * This is the same promise the saved sign-ins make: an export lists which sites are connected and
 * never the cookies that make them work.
 */
// agentcard_users added 2026-10-23: its tokens let a purchase run as the person, sealed or not.
// The rest (2026-11-07) are links and handshakes that open something: a checkout link, a Face ID
// approval, a guest's directory key, a join claim's code, a public stamp page, the saved card's
// and shopping profile's handles at Crossmint.
const SECRET_COLUMNS = {
  oauth_tokens: ["access_token", "refresh_token"], agentcard_users: ["access_token", "refresh_token", "session_url", "vault_session_id", "exchanged_session"], flight_travelers: ["details"],
  shop_cards: ["payment_method_id"], shop_profiles: ["profile_id"], shop_links: ["id"], shop_crossmint_subjects: ["sub", "from_conversation"],
  pay_approvals: ["id", "nonce", "challenge"], event_attendees: ["token"], event_claims: ["code"], stamp_shares: ["share_id"], web_setups: ["secret_hash", "code"],
};
// What a redacted column says instead, when it is not a credential.
const REDACTED_AS = { "flight_travelers.details": "[not exported: passenger details stay sealed on this machine; ask Reason for flight_travelers to read them]" };
// A handshake in flight belongs to nobody once it is spent, and a live one is a credential. Not
// redacted — dropped, because there is nothing in it worth having.
// fact_embeddings: vectors made from their facts, calls, actions and messages (src/recallindex.js).
// Nothing readable to export, but made from their words, so a delete takes them.
// pay_passkey_regs: a Face ID registration's challenge while it is under way, nothing else.
const DROP_FROM_EXPORT = ["oauth_states", "fact_embeddings", "pay_passkey_regs"];
const REDACTED = "[not exported: this is a live credential]";

function redactSecrets(table, rows) {
  if (table === "trips") return rows.map(scrubTrip);
  const cols = SECRET_COLUMNS[table];
  if (!cols) return rows;
  return rows.map(r => {
    const out = { ...r };
    for (const col of cols) out[col] = r[col] ? (REDACTED_AS[`${table}.${col}`] ?? REDACTED) : "";
    return out;
  });
}

/**
 * A walk in an export: where it went and when, never where it started. The route, its steps, OSRM's own
 * steps, the map round it and the streets all trace back to the start, so none of them leave; nor does
 * the link's key, which opens the page. The row itself is deleted when the walk ends (src/trips.js endTrip).
 */
const TRIP_EXPORTED = ["id", "made", "name", "address", "walk", "walkM", "startsAt", "startsLabel", "arriveByLabel", "entrance", "links"];
function scrubTrip(r) {
  let t = {};
  try { t = JSON.parse(r.trip); } catch { /* an unreadable row exports as nothing */ }
  const kept = Object.fromEntries(TRIP_EXPORTED.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));
  return { ...r, owner_key: r.owner_key ? REDACTED : "", trip: JSON.stringify({ ...kept, start: "[not exported: where the walk started]" }), streets: null };
}

// Tables keyed by page rather than by conversation: the browsers signed in to a page, the codes
// for it, the attempts at those codes. They follow their page, so a scoped export or delete
// reaches them through the pages in that conversation.
const PAGE_CHILD_TABLES = ["page_sessions", "page_codes", "page_attempts"];
// Install-wide rather than per person: who has asked for access, who is blocked, and the numbers
// told to wait. None of it is anybody's content, and all of it is the master's.
const GLOBAL_TABLES = ["access_requests", "blocked_numbers", "turned_away"];

/**
 * Tables with no `conversation_id` of their own, and the WHERE that reaches them anyway.
 *
 * Each is scoped through whatever does hold the conversation — its parent row, or in the case of
 * the video cache, the links that conversation actually sent. The number is how many times the
 * conversation id is bound, so a fragment can use it twice without the caller knowing.
 */
const CHILD_SCOPE = {
  person_facts: ["person_id IN (SELECT id FROM people WHERE conversation_id = ?)", 1],
  task_log: ["task_id IN (SELECT id FROM tasks WHERE conversation_id = ?)", 1],
  research_queries: ["research_id IN (SELECT id FROM research WHERE conversation_id = ?)", 1],
  research_sources: ["research_id IN (SELECT id FROM research WHERE conversation_id = ?)", 1],
  video_accounts: ["url IN (SELECT url FROM media_items WHERE conversation_id = ? AND url IS NOT NULL"
    + " UNION SELECT url FROM seen_urls WHERE conversation_id = ?)", 2],
  remote_events: ["job_id IN (SELECT id FROM remote_jobs WHERE conversation_id = ?)", 1],
  stranger_calls: ["matched_conversation_id = ?", 1],
  shop_run_asks: ["run_id IN (SELECT run_id FROM shop_runs WHERE conversation_id = ?)", 1],
  // A match is both people's; it goes when either side's offer does, contacts and all.
  ride_matches: ["driver_offer_id IN (SELECT id FROM ride_offers WHERE conversation_id = ?)"
    + " OR rider_offer_id IN (SELECT id FROM ride_offers WHERE conversation_id = ?)", 2],
  // A join claim is theirs once their own text spent it; an unspent one ages out with the event.
  event_claims: ["used_by = ?", 1],
  // A web setup is theirs once their first text claimed it (src/websetup.js); an unclaimed one ages out in a day.
  // claimed_by is the conversation's blind index (src/websetupstore.js), or the plain id from before phase 2.
  web_setups: ["claimed_by IN (?, websetup_owner(?))", 2],
};

/**
 * Every table this file knows about, by what an export and a delete do with it. The coverage test
 * (test/data-coverage.test.js) holds every table in the database to being in exactly one of these.
 */
export const COVERAGE = {
  deleted: [...TABLES, ...DROP_FROM_EXPORT, ...PAGE_CHILD_TABLES],
  global: GLOBAL_TABLES,
  kept: KEPT_ON_DELETE,
  installWide: INSTALL_WIDE,
};

// Tables are made by the module that owns them (src/shopconnect.js, src/passkey.js and the rest),
// and `npm run data:*` loads none of those. A table that does not exist yet has no rows to export
// or delete, so it is skipped rather than allowed to throw half way through a delete.
const present = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

// Which column ties a row to a conversation, or null for anything in CHILD_SCOPE.
function keyColumn(table) {
  if (table === "conversations") return "id";
  if (CHILD_SCOPE[table]) return null;
  // accounts, usage, connected_accounts and the rest are all keyed by conversation_id, which is
  // what makes an export or a delete "one person's" without any further bookkeeping.
  return "conversation_id";
}

/** `WHERE …` and its arguments for a child table, scoped to one conversation. */
function childScope(table, conversation) {
  const [where, n] = CHILD_SCOPE[table];
  return { where, args: Array.from({ length: n }, () => conversation) };
}

/**
 * Remove the saved browser profile(s) — the cookies that make a saved sign-in work.
 *
 * Scoped the same way everything else is: one conversation deletes one directory, no scope
 * deletes the lot. The path is built by `profilePath`, which the browser also uses, so there is no
 * way for this to delete a directory other than the one that person's logins are in — and it is
 * the non-creating variant on purpose: reporting a profile as removed after conjuring it into
 * existence first would be a lie with a count on it.
 */
function deleteProfiles(conversation = null) {
  const out = { listed: 0, deleted: 0, failed: [] };
  const targets = conversation
    ? [profilePath(conversation)]
    : (existsSync(config.profileRoot)
      ? readdirSync(config.profileRoot).map(d => join(config.profileRoot, d))
      : []);
  for (const dir of targets) {
    out.listed++;
    if (!existsSync(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      out.deleted++;
    } catch (e) {
      out.failed.push({ dir, error: (e?.message ?? String(e)).split("\n")[0] });
    }
  }
  return out;
}

/**
 * Remove the directories one person's handed-over work ran in.
 *
 * Scoped by being given the paths off their own rows rather than by walking the directory: a job
 * belongs to a conversation, and the only way to know which directories are that conversation's is
 * to read them from its rows. A whole-install delete can take the root as well, because then every
 * directory under it is in scope by definition.
 *
 * Each path is checked to be under `config.remoteRoot` before anything is removed. The paths come
 * from a column rather than from a caller, so this is belt and braces — but a function that calls
 * `rmSync(…, { recursive: true })` on a string out of a database earns a check on the string.
 */
function deleteRunDirs(dirs, conversation = null) {
  const out = { listed: 0, deleted: 0, already_gone: 0, failed: [] };
  const root = resolve(config.remoteRoot);
  const targets = conversation ? dirs : [...dirs, root];
  for (const dir of new Set(targets)) {
    const full = resolve(dir);
    if (full !== root && !full.startsWith(root + "/")) {
      out.failed.push({ dir, error: "not under the remote root, so it was left alone" });
      continue;
    }
    out.listed++;
    if (!existsSync(full)) { out.already_gone++; continue; }
    try {
      rmSync(full, { recursive: true, force: true });
      out.deleted++;
    } catch (e) {
      out.failed.push({ dir, error: (e?.message ?? String(e)).split("\n")[0] });
    }
  }
  return out;
}

/**
 * Everything Reason holds, as one object. `audio: false` leaves the recordings' bytes out and
 * keeps the list of them, which is what you want when you only came for the text.
 */
export function exportData({ conversation = null, audio = true, files = true } = {}) {
  const out = {
    install: { db: config.dbPath, owner: config.ownerName, exported_at: new Date().toISOString() },
    scope: conversation ?? "all",
    tables: {},
    recordings: [],
    documents: [],
  };

  for (const t of TABLES) {
    if (!present(t)) { out.tables[t] = []; continue; }
    const key = keyColumn(t);
    let rows;
    if (!conversation) rows = db.prepare(`SELECT * FROM ${t}`).all();
    else if (key) rows = db.prepare(`SELECT * FROM ${t} WHERE ${key} = ?`).all(conversation);
    else {
      const { where, args } = childScope(t, conversation);
      rows = db.prepare(`SELECT * FROM ${t} WHERE ${where}`).all(...args);
    }
    out.tables[t] = redactSecrets(t, rows);
  }
  if (SECRET_COLUMNS.oauth_tokens && out.tables.oauth_tokens?.length) {
    out.redacted = `${Object.entries(SECRET_COLUMNS).map(([t, c]) => `${t}.${c.join("/")}`).join(", ")} — the rows are here, the credential values are not. ${DROP_FROM_EXPORT.join(", ")} is left out entirely.`;
  }
  for (const t of GLOBAL_TABLES) out.tables[t] = db.prepare(`SELECT * FROM ${t}`).all();

  // A page is only half of itself without the browsers signed in to it and the answers on it.
  // Plus the person's own event sign-in key (src/events.js signinKey), which no page row carries,
  // and every browser signed in as them, whatever page it signed in on.
  const pageIds = [...out.tables.pages.map(p => p.id), ...(out.tables.trips ?? []).map(t => t.id), ...(conversation ? [`esign:${conversation}`] : [])];
  for (const t of PAGE_CHILD_TABLES) {
    const mine = t === "page_sessions" && conversation ? " OR conversation_id = ?" : "";
    out.tables[t] = !conversation
      ? db.prepare(`SELECT * FROM ${t}`).all()
      : db.prepare(`SELECT * FROM ${t} WHERE page_id IN (${pageIds.map(() => "?").join(",")})${mine}`).all(...pageIds, ...(mine ? [conversation] : []));
  }

  for (const rec of recordingFiles(conversation)) {
    const bytes = audio ? readRecording(rec.file) : null;
    out.recordings.push({
      ...rec,
      mime: mimeFor(rec.format),
      // Said out loud rather than silently omitted: an export has to report when a file the
      // database claims to have is not actually on disk.
      ...(audio ? { missing: bytes === null } : {}),
      ...(bytes ? { audio_base64: bytes.toString("base64") } : {}),
    });
  }

  // The documents, with their bytes inside the export. `files: false` is the same bargain
  // `audio: false` is: the list without the big part, for somebody who only came for the text.
  for (const doc of documentFiles(conversation)) {
    const bytes = files ? readDocument(doc.file) : null;
    out.documents.push({
      ...doc,
      mime: mimeForKind(doc.kind),
      // Said out loud rather than silently omitted, exactly as a missing recording is: an export
      // has to report when a file the database claims to have is not actually on disk.
      ...(files ? { missing: bytes === null } : {}),
      ...(bytes ? { file_base64: bytes.toString("base64") } : {}),
    });
  }
  return out;
}

/**
 * Everyone whose Google grant this delete is about to destroy the only record of.
 *
 * Deleting the rows is not the whole of cutting Google off: the grant lives on Google's side too,
 * and a delete that dropped the token would leave Reason listed in somebody's Google account with
 * nothing here able to revoke it afterwards. So the revoke happens first, while the refresh token
 * still exists, and what Google said is reported rather than assumed.
 *
 * Best effort by design. A machine with no network, or no client credentials, must still be able to
 * delete somebody's data — so a revoke that fails is a line in the result, never a reason to keep
 * their mailbox tokens on disk.
 */
async function revokeGoogleGrants(conversation, { fetchImpl = null } = {}) {
  // DISTINCT, and `all: true` below: one person can have several Google accounts connected, so a
  // conversation appears once per account here. Deleting their data means letting go of every one of
  // them, in one call per person rather than one per row — and `all` is passed explicitly because
  // `disconnect` refuses to guess which account somebody meant when they have more than one, which is
  // exactly the right behaviour for a person asking and exactly wrong for a full delete.
  const rows = conversation
    ? db.prepare("SELECT DISTINCT conversation_id FROM oauth_tokens WHERE provider = ? AND conversation_id = ?").all(google.PROVIDER, conversation)
    : db.prepare("SELECT DISTINCT conversation_id FROM oauth_tokens WHERE provider = ?").all(google.PROVIDER);
  const out = { listed: rows.length, revoked: 0, failed: [] };
  for (const r of rows) {
    try {
      const res = await google.disconnect(r.conversation_id, { all: true, ...(fetchImpl ? { fetchImpl } : {}) });
      if (res.revoked_at_google === true) out.revoked++;
      else out.failed.push({ conversation: r.conversation_id, error: res.revoke_error ?? "Google did not confirm the revoke" });
    } catch (e) {
      out.failed.push({ conversation: r.conversation_id, error: (e?.message ?? String(e)).split("\n")[0] });
    }
  }
  return out;
}

/**
 * Wipe it. Returns what was actually removed — rows, files, browser profiles, and what Google said
 * when it was asked to let go of the grants.
 *
 * Async because of that last part: asking Google to revoke is a real request, and doing it after the
 * token had been deleted would be impossible. Everything else here is still synchronous.
 */
export async function deleteData({ conversation = null, fetchImpl = null } = {}) {
  // Google first, while the refresh tokens are still here to revoke with.
  const googleGrants = await revokeGoogleGrants(conversation, { fetchImpl });

  // The files are read before the rows go, or there is nothing left pointing at them.
  const files = recordingFiles(conversation);
  const docs = documentFiles(conversation);

  // Read the page ids before the pages go, or their children cannot be found afterwards.
  // A walk's code gate keeps its codes and attempts under the trip's id, as a page's does.
  const pageIds = (conversation
    ? db.prepare("SELECT id FROM pages WHERE conversation_id = ? UNION ALL SELECT id FROM trips WHERE conversation_id = ?").all(conversation, conversation)
    : db.prepare("SELECT id FROM pages UNION ALL SELECT id FROM trips").all()).map(r => r.id);

  // Same for the handed-over work: the directories are named by job id, so they have to be listed
  // while the rows that name them are still here.
  const runDirs = (conversation
    ? db.prepare("SELECT run_dir FROM remote_jobs WHERE conversation_id = ?").all(conversation)
    : db.prepare("SELECT run_dir FROM remote_jobs").all()).map(r => r.run_dir).filter(Boolean);

  // The photos they added to event albums are files under data/event-albums/<event>/, named on
  // their rows: listed now, unlinked once the rows are gone, exactly as the recordings are.
  const photos = present("event_photos") && present("events")
    ? db.prepare(`SELECT p.file, e.public_id FROM event_photos p JOIN events e ON e.id = p.event_id${conversation ? " WHERE p.conversation_id = ?" : ""}`)
      .all(...(conversation ? [conversation] : []))
    : [];

  // An event they organised stays (KEPT_ON_DELETE), but nobody can run it any more: its automatic
  // reminders are switched off first, so the reminder record going with their rows below can never
  // read as "not sent yet" and text guests a second time (src/eventschedule.js).
  if (conversation && present("events")) {
    try { db.prepare("UPDATE events SET remind_day_before = 0, remind_soon = 0 WHERE organizer_conversation_id = ?").run(conversation); } catch { /* an older db without the columns */ }
  }

  const rows = {};
  const childIds = [...pageIds, ...(conversation ? [`esign:${conversation}`] : [])];
  for (const t of PAGE_CHILD_TABLES) {
    const mine = t === "page_sessions" && conversation ? " OR conversation_id = ?" : "";
    rows[t] = !conversation
      ? Number(db.prepare(`DELETE FROM ${t}`).run().changes)
      : Number(db.prepare(`DELETE FROM ${t} WHERE page_id IN (${childIds.map(() => "?").join(",")})${mine}`).run(...childIds, ...(mine ? [conversation] : [])).changes);
  }
  // Children before parents, so a row is never orphaned by its parent going first: task_log needs
  // tasks, research_queries and research_sources need research, person_facts needs people.
  const CHILDREN_FIRST = [...Object.keys(CHILD_SCOPE), ...TABLES.filter(t => !CHILD_SCOPE[t]), ...DROP_FROM_EXPORT];
  // A delete of the whole install takes what a scoped one deliberately keeps (KEPT_ON_DELETE): there
  // is nobody left for a billing record or a shared event to be kept for.
  if (!conversation) CHILDREN_FIRST.push(...Object.keys(KEPT_ON_DELETE));
  for (const t of CHILDREN_FIRST) {
    if (!present(t)) continue;
    const key = keyColumn(t);
    let r;
    if (!conversation) r = db.prepare(`DELETE FROM ${t}`).run();
    else if (key) r = db.prepare(`DELETE FROM ${t} WHERE ${key} = ?`).run(conversation);
    else {
      const { where, args } = childScope(t, conversation);
      r = db.prepare(`DELETE FROM ${t} WHERE ${where}`).run(...args);
    }
    rows[t] = Number(r.changes);
  }
  if (!conversation) {
    for (const t of GLOBAL_TABLES) rows[t] = Number(db.prepare(`DELETE FROM ${t}`).run().changes);
  } else {
    // A hash of the last passengers sent to AgentCard for them (src/tools.js flight_book).
    db.prepare("DELETE FROM ops_state WHERE k = ?").run(`flight:passengers_sent:${conversation}`);
  }

  // The browser profiles. These matter more than any row here: a saved sign-in IS a directory of
  // cookies, so a delete that cleared the database and left the profile behind would leave Reason
  // still able to act as that person on every site they had signed in to. The rows would say
  // nothing was connected while the browser went on being logged in, which is the worst of both.
  const profiles = deleteProfiles(conversation);

  const albumRoot = resolve(config.dataDir, "event-albums");
  const eventPhotos = { listed: photos.length, files_deleted: 0, failed: [] };
  for (const p of photos) {
    const f = join(albumRoot, basename(String(p.public_id)), basename(String(p.file)));
    try {
      if (existsSync(f)) { rmSync(f, { force: true }); eventPhotos.files_deleted++; }
    } catch (e) {
      eventPhotos.failed.push({ file: f, error: (e?.message ?? String(e)).split("\n")[0] });
    }
  }

  // The run directories. Same reasoning as the profiles: the row is not the whole of it. A job's
  // directory holds the brief it was handed — which quotes the master's own words — along with
  // everything the builder wrote back. Deleting the row and leaving the directory would leave his
  // words on disk while the database said they were gone.
  const builds = deleteRunDirs(runDirs, conversation);

  const recordings = { listed: files.length, files_deleted: 0, already_gone: 0, failed: [] };
  for (const f of files) {
    const r = deleteRecordingFile(f.file);
    if (!r.ok) recordings.failed.push({ file: f.file, error: r.error });
    else if (r.existed) recordings.files_deleted++;
    else recordings.already_gone++;
  }

  // The documents. The row going is not the delete: a .docx of somebody's cover letter left in
  // data/documents/ after they wiped their Reason is the file this unlinks.
  const documents = { listed: docs.length, files_deleted: 0, already_gone: 0, failed: [] };
  for (const d of docs) {
    const r = deleteDocumentFile(d.file);
    if (!r.ok) documents.failed.push({ file: d.file, error: r.error });
    else if (r.existed) documents.files_deleted++;
    else documents.already_gone++;
  }

  // Encryption at rest (src/restcrypt.js): their key goes too, so every backup taken before today
  // holds their words with no key. What a scoped delete keeps (KEPT_ON_DELETE) is re-sealed first.
  const sealedKey = conversation
    ? restcrypt.rotatePersonKey(rawPrepare, conversation)
    : { shredded: restcrypt.destroyAllKeys() > 0 };

  return {
    deleted_from: config.dbPath, scope: conversation ?? "all", rows, recordings, documents, profiles, builds, event_photos: eventPhotos,
    key_destroyed: !!sealedKey.shredded,
    google: {
      ...googleGrants,
      // Said out loud rather than quietly dropped: whoever runs a delete is entitled to know whether
      // Reason is still listed in somebody's Google account, and only Google can answer that.
      ...(googleGrants.failed.length
        ? { note: `The tokens are deleted either way, so nothing here can reach those accounts. Google would not confirm ${googleGrants.failed.length} revoke(s), so Reason may still be listed at myaccount.google.com/permissions for them — it has to be removed there by hand.` }
        : {}),
    },
  };
}

// ---------- CLI ----------
// Only when run directly, so both functions above stay importable by a test.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const mode = args[0] === "delete" ? "delete" : "export";
  const flags = new Set(args.filter(a => a.startsWith("--")));
  const conversation = args.slice(1).find(a => !a.startsWith("--")) ?? null;

  if (mode === "export") {
    process.stdout.write(JSON.stringify(exportData({ conversation, audio: !flags.has("--no-audio"), files: !flags.has("--no-files") }), null, 2) + "\n");
    process.exit(0);
  }

  if (!flags.has("--yes")) {
    const files = recordingFiles(conversation);
    const docs = documentFiles(conversation);
    console.error(`This deletes ${conversation ? `conversation '${conversation}'` : "EVERYTHING"} from ${config.dbPath}`
      + `${files.length ? `, and ${files.length} call recording(s) from disk` : ""}`
      + `${docs.length ? `, and ${docs.length} document(s) from disk` : ""}. It cannot be undone.`);
    console.error(`Export first:  npm run data:export${conversation ? ` -- ${conversation}` : ""} > reason-export.json`);
    console.error(`Then re-run with --yes.`);
    process.exit(1);
  }
  console.log(JSON.stringify(await deleteData({ conversation }), null, 2));
}
