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
import { db, recordingFiles } from "./db.js";
import { config } from "./config.js";
import { readRecording, deleteRecordingFile, mimeFor } from "./calls/recordings.js";

const TABLES = [
  "conversations", "plans", "timers", "memories", "people", "person_facts",
  "action_ledger", "confirmations", "tasks", "nudges", "threads", "calls", "watches",
  "pages", "page_choices", "seen_urls", "connected_accounts", "accounts", "usage",
];
// Tables keyed by page rather than by conversation: the browsers signed in to a page, the codes
// for it, the attempts at those codes. They follow their page, so a scoped export or delete
// reaches them through the pages in that conversation.
const PAGE_CHILD_TABLES = ["page_sessions", "page_codes", "page_attempts"];
// Install-wide rather than per person: the guest list, and the numbers turned away. Neither is
// anybody's content, and both are the operator's.
const GLOBAL_TABLES = ["invites", "turned_away"];

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
    out.tables[t] = !conversation
      ? db.prepare(`SELECT * FROM ${t}`).all()
      : key
        ? db.prepare(`SELECT * FROM ${t} WHERE ${key} = ?`).all(conversation)
        : db.prepare(`SELECT * FROM ${FACTS_BY_CONVERSATION}`).all(conversation);
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

/** Wipe it. Returns what was actually removed — rows and files. */
export function deleteData({ conversation = null } = {}) {
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
  for (const t of TABLES) {
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

  const recordings = { listed: files.length, files_deleted: 0, already_gone: 0, failed: [] };
  for (const f of files) {
    const r = deleteRecordingFile(f.file);
    if (!r.ok) recordings.failed.push({ file: f.file, error: r.error });
    else if (r.existed) recordings.files_deleted++;
    else recordings.already_gone++;
  }

  return { deleted_from: config.dbPath, scope: conversation ?? "all", rows, recordings };
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
  console.log(JSON.stringify(deleteData({ conversation }), null, 2));
}
