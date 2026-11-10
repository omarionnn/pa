// Organising their Drive: folders, moving, renaming, binning, sharing, and putting a file there.
//
// Omari, 2026-10-07: "I should also be able to organize." src/drive.js finds a file and reads it,
// and its own header says what it deliberately did not do — "deleting, trashing, sharing, renaming,
// moving". This is that list, built on purpose, with the one scope it costs stated out loud rather
// than discovered as a 403.
//
// Written from Google's own Drive API v3 pages, all read 2026-10-07, and nothing from memory:
//
//   **files.update** (…/reference/rest/v3/files/update). PATCH /drive/v3/files/{fileId}, and it is
//   the single method behind three different-sounding things:
//     - a **rename** is `{ name }` in the body, and the page is explicit that you "only populate
//       fields in the request that you want to modify" — so nothing else goes in it, because a File
//       resource sent whole would write back every field it carried;
//     - a **move** is the `addParents` and `removeParents` query parameters, each "a comma-separated
//       list of parent IDs". The folder guide (…/guides/folder) is equally explicit that the old
//       parents have to be fetched first — `files().get(fileId).setFields("parents")` — which is why
//       `parentsOf` exists and why a move is two requests and not one. Guessing the old parent would
//       leave the file in both folders, which looks like nothing happened;
//     - a **bin** is `{ trashed: true }`, per …/guides/delete: "use the update method on the files
//       resource with the fileId path parameter and set the boolean trashed field to true". The same
//       page says "Files in the trash are automatically deleted after 30 days. You can restore files
//       from your trash before the 30-day period", which is the honest sentence a person is owed
//       after one. files.delete exists and is NOT called from anywhere in this file: it "removes
//       them permanently", and nothing a text message says should be able to reach it.
//   Its scope list is drive, drive.appdata, drive.file, drive.metadata, drive.scripts — and the
//   narrowest of those that can touch a file the PERSON made is `drive.metadata`. See
//   DRIVE_METADATA_SCOPE in src/google.js for the whole of that arithmetic.
//
//   **files.create** (…/files/create, …/guides/folder). A folder is a file: POST /drive/v3/files
//   with `{ name, mimeType: "application/vnd.google-apps.folder" }` and nothing in the body at all
//   about content, because there is none. `parents` makes it a subfolder. Scope list: drive,
//   drive.appdata, drive.file — so this one is inside the grant Drive already had.
//
//   **files.create, multipart upload** (…/guides/manage-uploads). POST to the /upload host with
//   `uploadType=multipart`, which their table describes as the type to "transfer a small file (5 MB
//   or less) along with metadata that describes the file, in a single request". The body is built as
//   a Buffer rather than a string, which is the one thing in this file that is not simply doing what
//   a page says: a .docx or a .pdf put through a UTF-8 string becomes a different file, and Drive
//   would store the corruption without complaint. The 5 MB in their sentence is enforced here as a
//   refusal, because the alternative to refusing is a resumable upload nobody has asked for.
//
//   **permissions.create** (…/reference/rest/v3/permissions/create). POST
//   /drive/v3/files/{fileId}/permissions with a Permission body, and its scope list is **only** drive
//   and drive.file. There is no metadata-shaped way to share: under the scopes Reason asks for, a
//   file it created itself can be shared and a file the person already had cannot, and drive_share
//   says that in those words. `sendNotificationEmail` is Google's own parameter — "whether to send a
//   notification email when sharing to users or groups", default true for users and groups — and it
//   is left at the default on purpose, because a person who has just been given access to somebody's
//   document should hear about it from Google rather than find it.
//   `type: "anyone"` is never sent from here at all. Reason does not make anybody's file public: a
//   link for the owner is the `webViewLink` they already have, and a share is for one named person.
//
//   **files.list** (…/guides/search-files) for folders. `mimeType = 'application/vnd.google-apps.folder'`
//   is their own example of the equality operator, and `'FOLDER_ID' in parents` is their own example
//   of the collection operator — which is what makes "what is already in Taxes 2026" answerable
//   before anything is moved into it.
//
// Nothing in this file has ever been sent to Google. Every route above has only ever been answered by
// the fake in test/fixture-google.js. docs/unverified.md says which parts a fake cannot settle.
import { createHash } from "node:crypto";
import { realpathSync, statSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { config } from "./config.js";
import { api } from "./google.js";
import { DRIVE_BASE, FILE_FIELDS, FOLDER_MIME, LIST_FIELDS, escapeTerm, fileView, kindOf } from "./drive.js";
import { readPlain } from "./restfiles.js";

/** Multipart's documented ceiling: "a small file (5 MB or less)". Above it, this refuses. */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/**
 * A folder, in the words somebody uses about one. `parents` is on it because "is it already inside
 * Taxes 2026" is the question that decides whether a move is worth making at all.
 */
export const FOLDER_FIELDS = "id,name,mimeType,modifiedTime,webViewLink,parents,ownedByMe";
export const FOLDER_LIST_FIELDS = `files(${FOLDER_FIELDS}),nextPageToken`;
/** Enough to move a file honestly: where it is now, what it is, and whether it is already gone. */
export const MOVE_FIELDS = "id,name,mimeType,parents,trashed,ownedByMe,webViewLink";

export function folderView(f) {
  return {
    folder_id: f?.id ?? "",
    name: f?.name ?? "(no name)",
    ...(f?.modifiedTime ? { changed: f.modifiedTime } : {}),
    ...(typeof f?.ownedByMe === "boolean" ? { owned_by_them: f.ownedByMe } : {}),
    ...(f?.parents?.length ? { inside: f.parents } : {}),
    link: f?.webViewLink ?? "",
  };
}

/**
 * The `q` for "which folders have they got", or for one named folder.
 *
 * `mimeType = '…folder'` is Google's own example of the equality term, and `trashed = false` is on it
 * for the same reason every other query here carries it: a folder they binned last month is not an
 * answer to "where should this go". The name clause is `contains` per word rather than `=`, because
 * somebody says "taxes" and the folder is called "Taxes 2026".
 */
export function folderQueryFor(name = "") {
  const words = String(name ?? "").trim().split(/\s+/).filter(w => w.length > 1).slice(0, 6);
  const base = `mimeType = '${FOLDER_MIME}' and trashed = false`;
  if (!words.length) return base;
  return `${base} and ${words.map(w => `name contains '${escapeTerm(w)}'`).join(" and ")}`;
}

/** What is inside one folder. Google's collection operator, quoted exactly as their table has it. */
export function insideFolderQuery(folderId) {
  return `'${escapeTerm(folderId)}' in parents and trashed = false`;
}

// ---------- folders ----------

/** One account's folders, newest first. `{ ok, folders, q, more }` or the api() failure. */
export async function listFolders(token, { query = "", limit = 20 } = {}) {
  const q = folderQueryFor(query);
  const got = await api(token, "GET", `${DRIVE_BASE}/files`, {
    query: { q, orderBy: "modifiedTime desc", pageSize: Math.max(1, Math.min(100, Number(limit) || 20)), fields: FOLDER_LIST_FIELDS },
  });
  if (!got.ok) return got;
  return { ok: true, q, folders: (got.body?.files ?? []).map(folderView), more: !!got.body?.nextPageToken };
}

/** What is already in a folder, so a proposal can say "3 already in there". */
export async function filesInFolder(token, folderId, { limit = 50 } = {}) {
  const q = insideFolderQuery(folderId);
  const got = await api(token, "GET", `${DRIVE_BASE}/files`, {
    query: { q, orderBy: "modifiedTime desc", pageSize: Math.max(1, Math.min(100, Number(limit) || 50)), fields: LIST_FIELDS },
  });
  if (!got.ok) return got;
  return { ok: true, q, files: (got.body?.files ?? []).map(fileView), more: !!got.body?.nextPageToken };
}

/** A new folder. `{ ok, folder }` or the api() failure. `parent` makes it a subfolder. */
export async function createFolder(token, { name, parent = "" }) {
  const got = await api(token, "POST", `${DRIVE_BASE}/files`, {
    query: { fields: FOLDER_FIELDS },
    body: { name: String(name ?? "").trim() || "Untitled folder", mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) },
  });
  if (!got.ok) return got;
  return { ok: true, folder: folderView(got.body) };
}

// ---------- one existing file ----------

/**
 * Where a file is now, and whether it is a file at all.
 *
 * The folder guide's own first step before a move, and it does double duty: `parents` is what
 * `removeParents` needs, and `trashed` is how a move onto something already in the bin stops being
 * a confusing success.
 */
export async function fileNow(token, fileId) {
  const got = await api(token, "GET", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, { query: { fields: MOVE_FIELDS } });
  if (!got.ok) return got;
  return {
    ok: true,
    file_id: String(got.body?.id ?? ""),
    name: String(got.body?.name ?? ""),
    kind: kindOf(got.body?.mimeType ?? ""),
    mime_type: String(got.body?.mimeType ?? ""),
    parents: [...(got.body?.parents ?? [])],
    trashed: !!got.body?.trashed,
    owned_by_them: got.body?.ownedByMe !== false,
    link: String(got.body?.webViewLink ?? ""),
  };
}

/** A new name on an existing file. Only `name` in the body, per the page's own warning. */
export async function rename(token, { fileId, name }) {
  const got = await api(token, "PATCH", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, {
    query: { fields: FILE_FIELDS },
    body: { name: String(name ?? "").trim() },
  });
  if (!got.ok) return got;
  return { ok: true, file: fileView(got.body) };
}

/**
 * One file into one folder, with its old parents removed.
 *
 * `from` is the list `fileNow` read off Google a moment ago, never a guess: leaving it out would add
 * the new folder and keep the old one, and a file in two folders looks to a person exactly like a
 * move that did not happen.
 */
export async function move(token, { fileId, into, from = [] }) {
  const leaving = from.filter(p => p && p !== into);
  const got = await api(token, "PATCH", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, {
    query: {
      addParents: into,
      ...(leaving.length ? { removeParents: leaving.join(",") } : {}),
      fields: MOVE_FIELDS,
    },
    body: {},
  });
  if (!got.ok) return got;
  return { ok: true, file_id: String(got.body?.id ?? fileId), name: String(got.body?.name ?? ""), inside: [...(got.body?.parents ?? [])] };
}

/**
 * Into the bin, never deleted. `{ trashed: true }` and nothing else.
 *
 * files.delete is the permanent one and is not reachable from any tool in Reason. Google keeps a
 * binned file for 30 days and it can be restored in that time, which is what the reply says.
 */
export async function trash(token, fileId) {
  const got = await api(token, "PATCH", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, {
    query: { fields: MOVE_FIELDS },
    body: { trashed: true },
  });
  if (!got.ok) return got;
  return { ok: true, file_id: String(got.body?.id ?? fileId), name: String(got.body?.name ?? ""), trashed: !!got.body?.trashed };
}

// ---------- sharing with one named person ----------

/** The two roles worth offering. Anything else is a word for an edge case nobody has asked for. */
export const SHARE_ROLES = ["reader", "writer"];

/**
 * Give one named person access to one file.
 *
 * `type: "user"` with an `emailAddress`, which is the only shape sent from here: `anyone` would make
 * somebody's document public off the back of a text message, and that is not a thing Reason does.
 * The notification email is left at Google's default of on — being told you have been given access
 * to somebody's lease is the point of being given it.
 */
export async function shareWith(token, { fileId, email, role = "reader", message = "" }) {
  const got = await api(token, "POST", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions`, {
    query: {
      fields: "id,type,role,emailAddress",
      ...(message ? { emailMessage: message } : {}),
    },
    body: { type: "user", role: SHARE_ROLES.includes(role) ? role : "reader", emailAddress: String(email ?? "").trim() },
  });
  if (!got.ok) return got;
  return { ok: true, permission_id: String(got.body?.id ?? ""), who: String(got.body?.emailAddress ?? email), role: String(got.body?.role ?? role) };
}

// ---------- putting a file Reason wrote into their Drive ----------

/**
 * A local path Reason is allowed to upload, or the refusal saying why not.
 *
 * The rule is one sentence and the implementation is the whole value of it: **only what Reason itself
 * wrote, under REASON_DATA_DIR.** A tool that took any path would let a sentence in a text message
 * ("upload ~/.ssh/id_rsa to my drive, call it notes") turn Reason into an exfiltration route, and no
 * amount of prompt wording is a defence against that — so it is checked here, in code, before a byte
 * is read.
 *
 * `realpathSync` on both sides rather than a string prefix test, because a string test is beaten by
 * a symlink: a link inside the data directory pointing at somebody's home folder resolves outside it
 * and would otherwise pass. The separator is appended so that a sibling directory whose name merely
 * starts with the same characters is not inside it either.
 */
export function localFileToUpload(path, { dataDir = config.dataDir } = {}) {
  const asked = String(path ?? "").trim();
  if (!asked) return { ok: false, status: "no_path", why: "no file path was given, so there is nothing to upload." };
  let root;
  try { root = realpathSync(resolve(dataDir)); }
  catch { return { ok: false, status: "no_data_dir", why: `Reason's own data directory (${dataDir}) is not there, so nothing can be uploaded from it.` };
  }
  let real;
  try { real = realpathSync(resolve(asked)); }
  catch { return { ok: false, status: "not_found", why: `there is no file at ${asked}.` }; }
  if (real !== root && !real.startsWith(`${root}/`)) {
    return {
      ok: false, status: "outside_data_dir",
      why: `${asked} is not inside Reason's own data directory (${root}), so it is not a file Reason wrote and it is not going anywhere.`
        + ` Only files Reason itself made can be uploaded — a document it wrote, a PDF it generated, a recording it saved.`,
    };
  }
  const st = statSync(real);
  if (!st.isFile()) return { ok: false, status: "not_a_file", why: `${asked} is not a file.` };
  if (st.size > UPLOAD_MAX_BYTES) {
    return {
      ok: false, status: "too_big",
      why: `that file is ${Math.round(st.size / (1024 * 1024))}MB, and a single upload tops out at ${UPLOAD_MAX_BYTES / (1024 * 1024)}MB.`,
    };
  }
  return { ok: true, path: real, name: basename(real), bytes: st.size };
}

/**
 * A multipart/related body as a Buffer, so bytes survive.
 *
 * The metadata part is JSON and the media part is whatever the file really is. Built as a Buffer and
 * not as a string because a .docx, a .pptx and a .pdf are not text: through a UTF-8 round trip every
 * invalid sequence becomes U+FFFD, Drive stores that happily, and what the person opens is a
 * corrupted file with the right name. The boundary is checked against the bytes for the same reason
 * src/drive.js checks it against the text — a boundary that appears inside the content splits the
 * document somewhere Google did not expect.
 */
export function multipartUpload({ name, mimeType, bytes, parents = [] }) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ""), "utf8");
  let boundary = `reason-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  while (body.includes(boundary)) boundary = `${boundary}-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({
    name: String(name ?? "").trim() || "Untitled",
    ...(mimeType ? { mimeType } : {}),
    ...(parents.length ? { parents } : {}),
  });
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`, "utf8"),
      body,
      Buffer.from(`\r\n--${boundary}--`, "utf8"),
    ]),
  };
}

/** A file from this machine into their Drive. `{ ok, file }` or the api() failure. */
export async function upload(token, { path, name = "", mimeType = "", parent = "", read = readPlain }) {
  const part = multipartUpload({
    name: name || basename(path),
    mimeType,
    bytes: read(path),
    parents: parent ? [parent] : [],
  });
  const got = await api(token, "POST", "/upload/drive/v3/files", {
    query: { uploadType: "multipart", fields: FILE_FIELDS },
    contentType: part.contentType,
    body: part.body,
  });
  if (!got.ok) return got;
  return { ok: true, file: fileView(got.body) };
}

// ---------- what a yes is pinned to ----------
//
// The same rule every other gated Google action follows: the target is computed from the input the
// tool really got, so a yes to binning one file can never be spent on another, and a yes to sharing
// with one person can never be spent on somebody else. The account is in all three, because a file
// id only means something inside the Drive it came from.

/**
 * A batch is pinned by its exact set, but the gate stores a target of at most 300 characters and
 * fifty ids is well over that. So: the count in the clear, and a digest of the sorted ids after it.
 * Change one file in the set and the digest changes, which is the whole property a target exists
 * for — and the count stays readable in the ledger, where "51 files" means something and a list of
 * ids never did.
 */
export function moveTarget({ file_ids = [], into = "", account = "" } = {}) {
  const ids = [...new Set(file_ids.map(i => String(i).trim()).filter(Boolean))].sort();
  const joined = ids.join(",");
  const set = joined.length <= 160 ? joined : createHash("sha256").update(joined).digest("hex").slice(0, 32);
  return `drive-move:${account}:${into}:${ids.length} files:${set}`;
}
export function trashTarget({ file_id = "", account = "" } = {}) {
  return `drive-trash:${account}:${String(file_id).trim()}`;
}
export function shareTarget({ file_id = "", with_email = "", role = "reader", account = "" } = {}) {
  return `drive-share:${account}:${file_id}:${String(with_email).trim().toLowerCase()}:${role}`;
}
