// Your data, in one command.
//   npm run data:export                  everything, as JSON, to stdout
//   npm run data:export -- dm:owner      one conversation only
//   npm run data:export -- --no-audio    skip the call recordings' bytes (they are the big part)
//   npm run data:delete -- --yes             wipe everything, recordings included
//   npm run data:delete -- dm:owner --yes    wipe one conversation
//
// Deletion is real and immediate. It refuses to run without --yes.
//
// Call recordings are audio files on disk rather than rows, so they are handled explicitly at
// both ends: an export carries the bytes inside it, base64, with the checksum, so the export is a
// complete copy somebody could walk away with; and a delete unlinks the files as well as the
// rows. A delete that left the audio sitting in data/recordings/ would be exactly the kind of
// half-kept promise this file exists to avoid.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
  // What a day cost, and the OAuth grants. Both are somebody's own record of what Reason did for
  // them, so both belong in an export and a delete — but see SECRET_TABLES: the token values do not
  // leave the machine.
  "spend", "oauth_tokens",
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

// Which column ties a row to a conversation. person_facts has none — it hangs off people, which
// is where the conversation lives — so it is reached through its parent instead.
function keyColumn(table) {
  if (table === "conversations") return "id";
  if (table === "person_facts") return null;
  // accounts, usage, connected_accounts and the rest are all keyed by conversation_id, which is
  // what makes an export or a delete "one person's" without any further bookkeeping.
  return "conversation_id";
}

const FACTS_BY_CONVERSATION = "person_facts WHERE person_id IN (SELECT id FROM people WHERE conversation_id = ?)";

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
    const rows = !conversation
      ? db.prepare(`SELECT * FROM ${t}`).all()
      : key
        ? db.prepare(`SELECT * FROM ${t} WHERE ${key} = ?`).all(conversation)
        : db.prepare(`SELECT * FROM ${FACTS_BY_CONVERSATION}`).all(conversation);
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
  const rows = conversation
    ? db.prepare("SELECT conversation_id FROM oauth_tokens WHERE provider = ? AND conversation_id = ?").all(google.PROVIDER, conversation)
    : db.prepare("SELECT conversation_id FROM oauth_tokens WHERE provider = ?").all(google.PROVIDER);
  const out = { listed: rows.length, revoked: 0, failed: [] };
  for (const r of rows) {
    try {
      const res = await google.disconnect(r.conversation_id, fetchImpl ? { fetchImpl } : {});
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

  const rows = {};
  for (const t of PAGE_CHILD_TABLES) {
    rows[t] = !conversation
      ? Number(db.prepare(`DELETE FROM ${t}`).run().changes)
      : pageIds.length
        ? Number(db.prepare(`DELETE FROM ${t} WHERE page_id IN (${pageIds.map(() => "?").join(",")})`).run(...pageIds).changes)
        : 0;
  }
  for (const t of [...TABLES, ...DROP_FROM_EXPORT]) {
    const key = keyColumn(t);
    const r = !conversation
      ? db.prepare(`DELETE FROM ${t}`).run()
      : key
        ? db.prepare(`DELETE FROM ${t} WHERE ${key} = ?`).run(conversation)
        : db.prepare(`DELETE FROM ${FACTS_BY_CONVERSATION}`).run(conversation);
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

  const recordings = { listed: files.length, files_deleted: 0, already_gone: 0, failed: [] };
  for (const f of files) {
    const r = deleteRecordingFile(f.file);
    if (!r.ok) recordings.failed.push({ file: f.file, error: r.error });
    else if (r.existed) recordings.files_deleted++;
    else recordings.already_gone++;
  }

  return {
    deleted_from: config.dbPath, scope: conversation ?? "all", rows, recordings, profiles,
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
