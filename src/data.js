// Your data, in one command.
//   npm run data:export                  everything, as JSON, to stdout
//   npm run data:export -- dm:owner      one conversation only
//   npm run data:export -- --no-audio    skip the call recordings' bytes (they are the big part)
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
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { db, recordingFiles } from "./db.js";
import { config } from "./config.js";
import { profilePath } from "./browser.js";
import { readRecording, deleteRecordingFile, mimeFor } from "./calls/recordings.js";
import * as google from "./google.js";

const TABLES = [
  "conversations", "plans", "timers", "memories", "people", "person_facts",
  "action_ledger", "confirmations", "tasks", "nudges", "threads", "calls", "watches",
  "pages", "page_choices", "seen_urls", "connected_accounts", "accounts", "usage",
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
];

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
const SECRET_COLUMNS = { oauth_tokens: ["access_token", "refresh_token"] };
// A handshake in flight belongs to nobody once it is spent, and a live one is a credential. Not
// redacted — dropped, because there is nothing in it worth having.
const DROP_FROM_EXPORT = ["oauth_states"];
const REDACTED = "[not exported: this is a live credential]";

function redactSecrets(table, rows) {
  const cols = SECRET_COLUMNS[table];
  if (!cols) return rows;
  return rows.map(r => {
    const out = { ...r };
    for (const col of cols) out[col] = r[col] ? REDACTED : "";
    return out;
  });
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
};

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
export function exportData({ conversation = null, audio = true } = {}) {
  const out = {
    install: { db: config.dbPath, owner: config.ownerName, exported_at: new Date().toISOString() },
    scope: conversation ?? "all",
    tables: {},
    recordings: [],
  };

  for (const t of TABLES) {
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
  const pageIds = out.tables.pages.map(p => p.id);
  for (const t of PAGE_CHILD_TABLES) {
    out.tables[t] = !conversation
      ? db.prepare(`SELECT * FROM ${t}`).all()
      : pageIds.length
        ? db.prepare(`SELECT * FROM ${t} WHERE page_id IN (${pageIds.map(() => "?").join(",")})`).all(...pageIds)
        : [];
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

  // Read the page ids before the pages go, or their children cannot be found afterwards.
  const pageIds = (conversation
    ? db.prepare("SELECT id FROM pages WHERE conversation_id = ?").all(conversation)
    : db.prepare("SELECT id FROM pages").all()).map(r => r.id);

  // Same for the handed-over work: the directories are named by job id, so they have to be listed
  // while the rows that name them are still here.
  const runDirs = (conversation
    ? db.prepare("SELECT run_dir FROM remote_jobs WHERE conversation_id = ?").all(conversation)
    : db.prepare("SELECT run_dir FROM remote_jobs").all()).map(r => r.run_dir).filter(Boolean);

  const rows = {};
  for (const t of PAGE_CHILD_TABLES) {
    rows[t] = !conversation
      ? Number(db.prepare(`DELETE FROM ${t}`).run().changes)
      : pageIds.length
        ? Number(db.prepare(`DELETE FROM ${t} WHERE page_id IN (${pageIds.map(() => "?").join(",")})`).run(...pageIds).changes)
        : 0;
  }
  // Children before parents, so a row is never orphaned by its parent going first: task_log needs
  // tasks, research_queries and research_sources need research, person_facts needs people.
  const CHILDREN_FIRST = [...Object.keys(CHILD_SCOPE), ...TABLES.filter(t => !CHILD_SCOPE[t]), ...DROP_FROM_EXPORT];
  for (const t of CHILDREN_FIRST) {
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
  }

  // The browser profiles. These matter more than any row here: a saved sign-in IS a directory of
  // cookies, so a delete that cleared the database and left the profile behind would leave Reason
  // still able to act as that person on every site they had signed in to. The rows would say
  // nothing was connected while the browser went on being logged in, which is the worst of both.
  const profiles = deleteProfiles(conversation);

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

  return {
    deleted_from: config.dbPath, scope: conversation ?? "all", rows, recordings, profiles, builds,
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
    process.stdout.write(JSON.stringify(exportData({ conversation, audio: !flags.has("--no-audio") }), null, 2) + "\n");
    process.exit(0);
  }

  if (!flags.has("--yes")) {
    const files = recordingFiles(conversation);
    console.error(`This deletes ${conversation ? `conversation '${conversation}'` : "EVERYTHING"} from ${config.dbPath}`
      + `${files.length ? `, and ${files.length} call recording(s) from disk` : ""}. It cannot be undone.`);
    console.error(`Export first:  npm run data:export${conversation ? ` -- ${conversation}` : ""} > reason-export.json`);
    console.error(`Then re-run with --yes.`);
    process.exit(1);
  }
  console.log(JSON.stringify(await deleteData({ conversation }), null, 2));
}
