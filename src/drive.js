// Their Drive: find a file, read what is in it, and make a document when they ask for one.
//
// Written from Google's own Drive API v3 pages, all read 2026-10-06, and nothing from memory:
//
//   **files.list** (…/reference/rest/v3/files/list, and the *Search for files and folders* guide).
//   GET /drive/v3/files with `q`, which the guide describes as "a search query combining one or more
//   search terms" in the form `query_term operator values`. The terms used below are the ones in that
//   guide's own table: `name contains 'budget'`, `fullText contains 'hello'`, `trashed = false`. It
//   also says, in so many words, that a value's apostrophes and backslashes have to be escaped with a
//   backslash — so `escapeTerm` is not a precaution, it is the documented requirement, and without it
//   a file called "quinn's lease" is a malformed query rather than a result.
//   `orderBy` takes "a comma-separated list of sort keys", `modifiedTime` is one of them, and each key
//   "sorts ascending by default, but can be reversed with the desc modifier" — hence
//   `modifiedTime desc` for newest first. `pageSize` is "the maximum number of files to return", max
//   1000. And `fields`: the guide is explicit that without it the list method "returns only the kind,
//   id, name, mimeType, and resourceKey fields for each file", which is why FIELDS is always sent —
//   the modified time, the owner and the link are things a person asks about and they are not in the
//   default.
//
//   **files.get** (…/files/get). GET /drive/v3/files/{fileId} returns the File resource; "If you
//   provide the URL parameter alt=media, then the response includes the file contents in the response
//   body", and the same page says that to download Docs, Sheets and Slides you use files.export
//   instead. Both halves are honoured here: the metadata read first decides which of the two to do.
//
//   **files.export** (…/files/export). GET /drive/v3/files/{fileId}/export with a required `mimeType`,
//   "returns exported byte content", capped by Google at 10 MB. The formats come from their export
//   table (…/guides/ref-export-formats): Documents → `text/plain`, Presentations → `text/plain`,
//   Spreadsheets → `text/csv`, where csv is marked **"(first-sheet only)"**. That bracket is why a
//   spreadsheet comes back saying it is the first sheet rather than quietly reading as the whole
//   workbook — a number from the wrong tab is worse than no number.
//
//   **files.create, multipart** (…/files/create and …/guides/manage-uploads). POST
//   https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart, which their table describes
//   as the type to "transfer a small file (5 MB or less) along with metadata that describes the file,
//   in a single request", the body a `multipart/related` document whose first part is the metadata as
//   `application/json` and whose second part is the content. `application/vnd.google-apps.document` is
//   Google Docs in their Workspace MIME type table (…/guides/mime-types), and files.create's scope
//   list is drive, drive.appdata or drive.file — so making a Doc sits inside the non-sensitive
//   `drive.file` scope and nothing broader is asked for.
//
// What is not here, and where it went. Trashing, sharing, renaming, moving and uploading are
// **src/driveorg.js** as of 2026-10-07 ("I should also be able to organize"). A separate file because
// they are a separate grant: organising a file the person made themselves is files.update, which
// neither scope above can reach, so it costs one more line on somebody's consent screen and is asked
// for only when they actually want it. Changing what is INSIDE an existing document is still not
// possible at all. Nor is permanent deletion: files.delete is reachable from nowhere in Reason, and
// Google keeps a binned file for 30 days.
//
// Nothing in this file has ever been sent to Google. Every route above has only ever been answered by
// the fake in test/fixture-google.js. docs/unverified.md says which parts a fake cannot settle.
import { config } from "./config.js";
import { cut } from "./cut.js";
import { api } from "./google.js";
import { pdfRefusal, pdfText } from "./pdf.js";
import { readableText } from "./weblookup.js";

// Re-exported because this is where a Drive read's cutting has always been reached from, and moving
// the function should not move where callers and tests look for it. See src/cut.js for why it moved.
export { cut };

export const DRIVE_BASE = "/drive/v3";
/** The /upload host is a different path on the same base — see manage-uploads. */
export const UPLOAD_BASE = "/upload/drive/v3";

export const DOC_MIME = "application/vnd.google-apps.document";
export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const SLIDES_MIME = "application/vnd.google-apps.presentation";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Exactly the fields a person asks about, and no more.
 *
 * Kept short on purpose: a File resource has dozens of fields, most of them meaningless in a text
 * conversation, and a search result full of them is a turn nobody can afford. What is here is what
 * somebody means by "which one is it" — the name, what kind of thing it is, when it last changed,
 * whose it is, the link to open it, and how big it is.
 */
export const FILE_FIELDS = "id,name,mimeType,modifiedTime,owners(displayName,emailAddress),ownedByMe,webViewLink,size";
export const LIST_FIELDS = `files(${FILE_FIELDS}),nextPageToken`;

/**
 * A value that cannot break out of a `q` term.
 *
 * Google's search guide: "You must also escape special characters in your file names to make sure the
 * query works correctly. For example, if a filename contains both an apostrophe (') and a backslash
 * ("\") character, use a backslash to escape them". Backslash first, or escaping the apostrophe would
 * then be escaped again. Newlines go because a query is one line.
 */
export function escapeTerm(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[\r\n]+/g, " ").trim();
}

/** The words a query is really made of: at most six, nothing empty, nothing of one character. */
function wordsOf(query) {
  return String(query ?? "").trim().split(/\s+/).filter(w => w.length > 1).slice(0, 6);
}

/**
 * The `q` for what they asked for, built in code rather than left to the model.
 *
 * Two clauses, OR'd, and the asymmetry between them is deliberate:
 *
 *   - **the name has to carry every word** (`name contains 'lease' and name contains 'agreement'`),
 *     because "any of the words" would make "lease pdf" return every PDF they own;
 *   - **the full text is searched for the phrase as they said it**, which is Google's own
 *     `fullText contains` term — that is what finds a lease whose file is called "Scan 47".
 *
 * `trashed = false` is on every query because files.list "returns all files by default, including
 * trashed files", and a document they deleted last month is not an answer to "find my lease".
 *
 * An empty query is not an error: it is "what have I been working on", and it comes back as their
 * most recently changed files, which is what `orderBy` already gives.
 */
export function queryFor(query) {
  const words = wordsOf(query);
  if (!words.length) return "trashed = false";
  const byName = words.map(w => `name contains '${escapeTerm(w)}'`).join(" and ");
  const phrase = escapeTerm(words.join(" "));
  return `trashed = false and ((${byName}) or fullText contains '${phrase}')`;
}

/** One file, in the words somebody uses about it. Which account it came from is added by the caller. */
export function fileView(f) {
  const owners = (f?.owners ?? []).map(o => o.displayName || o.emailAddress).filter(Boolean);
  return {
    file_id: f?.id ?? "",
    name: f?.name ?? "(no name)",
    kind: kindOf(f?.mimeType ?? ""),
    mime_type: f?.mimeType ?? "",
    ...(f?.modifiedTime ? { changed: f.modifiedTime } : {}),
    ...(owners.length ? { owner: owners.join(", ") } : {}),
    // Whether the account this came out of OWNS it, which Drive knows and a name in a list does not
    // say. Who a file is ABOUT is a different question again — see the note on drive_search.
    ...(typeof f?.ownedByMe === "boolean" ? { owned_by_them: f.ownedByMe } : {}),
    ...(f?.size ? { kb: Math.max(1, Math.round(Number(f.size) / 1024)) } : {}),
    link: f?.webViewLink ?? "",
  };
}

/** What kind of thing this is, said the way a person would say it rather than as a MIME type. */
export function kindOf(mimeType) {
  const m = String(mimeType ?? "");
  if (m === DOC_MIME) return "google doc";
  if (m === SHEET_MIME) return "google sheet";
  if (m === SLIDES_MIME) return "google slides";
  if (m === FOLDER_MIME) return "folder";
  if (m === "application/pdf") return "pdf";
  if (m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "word document";
  if (m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "excel spreadsheet";
  if (m === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "powerpoint deck";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "text/html") return "web page";
  if (m.startsWith("text/")) return "text file";
  return m || "file";
}

/**
 * How this file's text can be got at, or that it cannot be.
 *
 * `{ how: "export", mimeType }` — a Workspace document, through files.export in the format Google's
 * export table gives for it. `{ how: "media" }` — bytes Drive is only storing, through
 * `alt=media`, which is what files.get documents for exactly that case. `{ how: "no", why }` —
 * everything else, and the `why` is the sentence a person gets told.
 *
 * `{ how: "pdf" }` — bytes through the same `alt=media`, and then read on this machine by src/pdf.js.
 * It is its own plan rather than `media` with a flag because the download has to be binary: `raw`
 * decodes as UTF-8 and a PDF does not survive that.
 *
 * The honest list of noes still matters as much as the yeses. A PDF now has text got out of it where
 * there is text to get, and where there is not — a scan, a password, a document too big — it says
 * which of those it was, in src/pdf.js's words, rather than handing over mojibake or a paragraph
 * written from the file's name.
 */
export function textPlan(mimeType) {
  const m = String(mimeType ?? "");
  if (m === DOC_MIME) return { how: "export", mimeType: "text/plain" };
  if (m === SLIDES_MIME) return { how: "export", mimeType: "text/plain" };
  if (m === SHEET_MIME) {
    return {
      how: "export", mimeType: "text/csv",
      // Google's own bracket in the export table, carried through to the person: a workbook with
      // twelve tabs reads back as one of them, and saying which is the difference between a useful
      // answer and a confidently wrong one.
      note: "This is the FIRST SHEET only, as comma-separated rows — Google's csv export is first-sheet only. If what they asked about might be on another tab, say that you only have the first one and offer them the link.",
    };
  }
  if (m === FOLDER_MIME) {
    return { how: "no", why: "that's a folder, not a file — there's nothing in it to read as text" };
  }
  if (m === "text/html") return { how: "media", html: true };
  // text/plain, text/csv, text/markdown, text/tab-separated-values and the rest of text/* are stored
  // as bytes Drive does not interpret, so alt=media hands back exactly what is in them.
  if (m.startsWith("text/") || m === "application/json" || m === "application/xml") return { how: "media" };
  if (m === "application/pdf") return { how: "pdf" };
  return { how: "no", why: `that's a ${kindOf(m)}, and reason can't read that one` };
}

/**
 * A multipart/related body for files.create, and the content type that goes with it.
 *
 * The boundary is generated and then checked against the text, because a boundary that appears inside
 * the content would split the document somewhere Google did not expect and upload half a file under a
 * mangled name. Checked rather than assumed: the text is somebody's own words and may contain
 * anything.
 */
export function multipartDoc({ title, text, mimeType = DOC_MIME }) {
  const body = String(text ?? "");
  let boundary = `reason-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  while (body.includes(boundary)) boundary = `${boundary}-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name: String(title ?? "").trim() || "Untitled", mimeType });
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    boundary,
    body: `--${boundary}\r\n`
      + "Content-Type: application/json; charset=UTF-8\r\n\r\n"
      + `${metadata}\r\n`
      + `--${boundary}\r\n`
      + "Content-Type: text/plain; charset=UTF-8\r\n\r\n"
      + `${body}\r\n`
      + `--${boundary}--`,
  };
}

// ---------- the three calls ----------

/** Search one account's Drive. `{ ok, files, more }` or the api() failure, unchanged. */
export async function search(token, { query = "", limit = 10 } = {}) {
  const got = await api(token, "GET", `${DRIVE_BASE}/files`, {
    query: {
      q: queryFor(query),
      orderBy: "modifiedTime desc",
      pageSize: Math.max(1, Math.min(50, Number(limit) || 10)),
      fields: LIST_FIELDS,
    },
  });
  if (!got.ok) return got;
  return {
    ok: true,
    q: queryFor(query),
    files: (got.body?.files ?? []).map(fileView),
    more: !!got.body?.nextPageToken,
  };
}

/** One file's metadata. `{ ok, file, raw }` or the api() failure. */
export async function meta(token, fileId) {
  const got = await api(token, "GET", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, {
    query: { fields: FILE_FIELDS },
  });
  if (!got.ok) return got;
  return { ok: true, file: fileView(got.body), mime_type: String(got.body?.mimeType ?? "") };
}

/**
 * The text of one file, by whichever of the documented routes its type takes.
 *
 * Returns `{ ok: true, text, truncated, chars, note }`, or `{ ok: false, cannot: true, why }` for a
 * type there is no honest way to read, or the api() failure for anything Google refused.
 *
 * A PDF comes back `cannot` too when there is no text in it to have — but with `pdf` on it carrying
 * the reason and the next step, so the caller can say which kind of no it was. That is the difference
 * between "it's password-protected" and "reason can't read a pdf", and a person is owed it.
 */
export async function text(token, fileId, mimeType, { maxChars = config.driveTextChars, readPdf = pdfText } = {}) {
  const plan = textPlan(mimeType);
  if (plan.how === "no") return { ok: false, cannot: true, why: plan.why };

  if (plan.how === "pdf") {
    const got = await api(token, "GET", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, { query: { alt: "media" }, binary: true });
    if (!got.ok) return got;
    const read = await readPdf({ bytes: got.bytes });
    if (!read.ok) return { ok: false, cannot: true, why: pdfRefusal(read), pdf: read };
    return {
      ok: true, how: "pdf",
      ...cut(read.text, maxChars),
      pages: read.pages, pages_read: read.pages_read,
    };
  }

  const got = plan.how === "export"
    ? await api(token, "GET", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export`, { query: { mimeType: plan.mimeType }, raw: true })
    : await api(token, "GET", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, { query: { alt: "media" }, raw: true });
  if (!got.ok) return got;
  // An HTML file goes through the same reader a fetched web page does, so there is one place in
  // Reason that turns markup into words rather than two that disagree.
  const raw = plan.html ? readableText(got.text ?? "", Number.MAX_SAFE_INTEGER).text : (got.text ?? "");
  const out = cut(raw, maxChars);
  return {
    ok: true, how: plan.how,
    ...(plan.mimeType ? { exported_as: plan.mimeType } : {}),
    ...out,
    ...(plan.note ? { note: plan.note } : {}),
  };
}

/** A new Google Doc from plain text. `{ ok, file }` or the api() failure. */
export async function createDoc(token, { title, text: body }) {
  const part = multipartDoc({ title, text: body });
  const got = await api(token, "POST", `${UPLOAD_BASE}/files`, {
    query: { uploadType: "multipart", fields: FILE_FIELDS },
    contentType: part.contentType,
    body: part.body,
  });
  if (!got.ok) return got;
  return { ok: true, file: fileView(got.body) };
}
