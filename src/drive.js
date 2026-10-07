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

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

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
  if (m === PDF_MIME) return "pdf";
  if (m === DOCX_MIME) return "word document";
  if (m === XLSX_MIME) return "excel spreadsheet";
  if (m === PPTX_MIME) return "powerpoint deck";
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

// ---------- handing a file back in the format they asked for ----------
//
// "send me my latest resume as a pdf" used to end in a sentence saying Reason could not do it. It
// could read the file and it could write a new one, and neither of those is what was asked for:
// what was asked for is THAT file, in that format, in the thread.
//
// Written from Drive v3, read 2026-10-07, and nothing from memory:
//
//   **files.export** (…/files/export) with the conversions in Google's own export table
//   (…/guides/ref-export-formats). A Document exports to `application/pdf` and to the Word type; a
//   Presentation and a Spreadsheet export to `application/pdf` but NOT to Word, because a deck is
//   not a Word document and converting it into one would be a worse answer than saying no. Google
//   caps an export at 10 MB and says so with a 403, which is passed straight through.
//
//   **files.copy** (…/files/copy). POST /drive/v3/files/{fileId}/copy, whose body is a File
//   resource — "Setting the mimeType in the metadata converts the file to the corresponding Google
//   Workspace type" is the documented way to open a .docx as a Doc. That is the whole trick for a
//   file Drive is only storing: copy it INTO a Doc, export THAT as a PDF, and delete the copy.
//
//   **files.delete** (…/files/delete). "Permanently deletes a file owned by the user without moving
//   it to the trash." The bin is the wrong place for the copy — it would sit in their Drive looking
//   like something they deleted — and the copy was made by this app, which is what `drive.file`
//   covers. The delete runs on every path after the copy exists, including the one where the export
//   failed, and the result says whether it really went: a stray copy in somebody's Drive is a thing
//   Reason put there, and it is not allowed to be silent about one.
//
// Drive does the converting rather than this machine, and that is a choice. macOS can convert a
// .docx — `textutil` reads one — but only out to html or rtf, so a PDF would mean textutil into
// Chromium's printer: two conversions by two things that do not own the format, and a resume is the
// document where losing the layout shows most. Drive's converter is the one Google uses when
// somebody opens that same .docx in Docs themselves, so it is the closest thing to what they would
// get by hand, and it is the same engine on every machine Reason is installed on instead of only on
// a Mac. The cost is the temporary copy, which is why the copy is tracked as carefully as it is.
// The local reader in src/pdf.js is unaffected: reading a PDF stays on this machine.
//
// None of this has been run against a real Drive. docs/unverified.md says exactly that.

/** The two formats a file can be handed back in, and what a phone has to be told each one is. */
export const HAND_BACK = {
  pdf: { mime: PDF_MIME, kind: "pdf", what: "a PDF" },
  docx: { mime: DOCX_MIME, kind: "docx", what: "a Word document" },
};

/**
 * Which Google Workspace type each stored file opens as, which is the only way Drive converts one.
 *
 * Exactly the types Google's own "convert on upload or copy" path handles. Apple's formats are not
 * here because Drive cannot open them at all — it stores a .pages the way it stores a zip — and a
 * conversion that silently produced nothing is worse than a sentence saying so.
 */
const OPENS_AS = new Map([
  [DOCX_MIME, DOC_MIME],
  ["application/msword", DOC_MIME],
  ["application/vnd.oasis.opendocument.text", DOC_MIME],
  ["application/rtf", DOC_MIME],
  ["text/rtf", DOC_MIME],
  ["text/plain", DOC_MIME],
  ["text/markdown", DOC_MIME],
  ["text/html", DOC_MIME],
  [PPTX_MIME, SLIDES_MIME],
  ["application/vnd.ms-powerpoint", SLIDES_MIME],
  ["application/vnd.oasis.opendocument.presentation", SLIDES_MIME],
  [XLSX_MIME, SHEET_MIME],
  ["application/vnd.ms-excel", SHEET_MIME],
  ["application/vnd.oasis.opendocument.spreadsheet", SHEET_MIME],
  ["text/csv", SHEET_MIME],
  ["text/tab-separated-values", SHEET_MIME],
]);

/** Google's export table, cut down to the two formats anybody asks a file to arrive as. */
const EXPORTS_TO = new Map([
  [DOC_MIME, [PDF_MIME, DOCX_MIME]],
  [SLIDES_MIME, [PDF_MIME]],
  [SHEET_MIME, [PDF_MIME]],
]);

/** An Apple document is a file Drive holds and cannot open, and that is its own sentence. */
const APPLE = new Map([
  ["application/vnd.apple.pages", "Pages"],
  ["application/vnd.apple.keynote", "Keynote"],
  ["application/vnd.apple.numbers", "Numbers"],
]);

/**
 * How this file can become the thing they asked for, or why it cannot.
 *
 *   `{ how: "as_is" }`   — it already is one. Downloaded and handed over untouched, which is the
 *                          only honest answer to "send me that pdf": their file, not a copy of it
 *                          Reason typed out again.
 *   `{ how: "export", mimeType }` — a Docs Editors file, through files.export.
 *   `{ how: "convert", via, mimeType }` — a stored file, copied into `via` and exported from there.
 *   `{ how: "no", why }` — and `why` is the sentence a person gets told, with what CAN be done.
 */
export function handBackPlan(mimeType, as) {
  const want = HAND_BACK[as];
  if (!want) return { how: "no", why: `reason only hands a file back as a pdf or a word doc, not as '${as}'` };
  const m = String(mimeType ?? "");

  if (m === want.mime) return { how: "as_is", mimeType: want.mime };
  if (m === FOLDER_MIME) return { how: "no", why: "that's a folder, not a file — there's nothing in it to turn into anything" };
  if (APPLE.has(m)) {
    return {
      how: "no",
      why: `that's an Apple ${APPLE.get(m)} file, and Drive can't open one — it only stores it.`
        + ` Exporting it as ${as === "pdf" ? "a PDF" : "a Word file"} from ${APPLE.get(m)} on their own machine is the way, and then reason can do anything with it`,
    };
  }

  if (EXPORTS_TO.get(m)?.includes(want.mime)) return { how: "export", mimeType: want.mime };
  // A Sheet or Slides asked for as Word: Google exports neither, and it is the right refusal rather
  // than a near-miss. The PDF is the real thing that can be done, so it is named.
  if (EXPORTS_TO.has(m)) return { how: "no", why: `that's ${kindOf(m)}, and a word doc isn't what it is — a PDF of it is the one that works` };

  const via = OPENS_AS.get(m);
  if (via && EXPORTS_TO.get(via)?.includes(want.mime)) return { how: "convert", via, mimeType: want.mime };
  if (via) return { how: "no", why: `that's ${kindOf(m)}, and a word doc isn't what it is — a PDF of it is the one that works` };

  if (m === PDF_MIME) {
    return {
      how: "no",
      why: "turning a PDF back into a Word file means guessing at the layout from a picture of it, and what comes out isn't the document."
        + " The PDF itself can be sent, and what it says can be read out",
    };
  }
  return { how: "no", why: `that's ${kindOf(m)}, and there's no honest way to turn one of those into ${as === "pdf" ? "a PDF" : "a word doc"}` };
}

/** The name the temporary copy carries, so a stray one is obvious and findable rather than a mystery. */
export function copyName(name) {
  return `reason temporary copy — ${String(name ?? "").slice(0, 120) || "file"}`;
}

/** One files.export, as bytes. Binary because a PDF and a .docx do not survive a UTF-8 round trip. */
export async function exportBytes(token, fileId, mimeType) {
  return api(token, "GET", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export`, {
    query: { mimeType }, binary: true,
  });
}

/** Permanently delete one file. Used for nothing but a copy this code made moments earlier. */
export async function deleteFile(token, fileId) {
  const got = await api(token, "DELETE", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`);
  return got.ok ? { ok: true } : got;
}

/**
 * One file's bytes, in the format they asked for.
 *
 * `{ ok: true, how, bytes, ... }`, or `{ ok: false, cannot: true, why }` for a conversion there is
 * no honest way to do, or the api() failure for anything Google refused — with `while` on it saying
 * which step it was, because "it could not be copied" and "the copy could not be exported" lead to
 * different next moves.
 *
 * `temp_copy` is on every result that made one, whether or not the export worked, and it says
 * whether the delete really went through. That is the whole of the promise that nothing is left
 * behind in their Drive: it is reported, not assumed.
 */
export async function handBack(token, fileId, mimeType, as, { name = "" } = {}) {
  const plan = handBackPlan(mimeType, as);
  if (plan.how === "no") return { ok: false, cannot: true, why: plan.why };

  if (plan.how === "as_is") {
    const got = await api(token, "GET", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, { query: { alt: "media" }, binary: true });
    if (!got.ok) return { ...got, while: "download" };
    return { ok: true, how: "as_is", bytes: got.bytes, content_type: got.content_type };
  }

  if (plan.how === "export") {
    const got = await exportBytes(token, fileId, plan.mimeType);
    if (!got.ok) return { ...got, while: "export" };
    return { ok: true, how: "export", exported_as: plan.mimeType, bytes: got.bytes, content_type: got.content_type };
  }

  // The copy, the export, and then the delete — which happens whatever the export did.
  const copy = await api(token, "POST", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/copy`, {
    query: { fields: "id,name,mimeType" },
    body: { name: copyName(name), mimeType: plan.via },
  });
  if (!copy.ok) return { ...copy, while: "copy" };
  const copyId = String(copy.body?.id ?? "");
  if (!copyId) {
    return {
      ok: false, while: "copy",
      error: "Drive made a temporary copy and did not say what its id is, so it could not be read back — and it could not be cleaned up either. Say that, and that there may be a file called \"" + copyName(name) + "\" in their Drive to delete.",
    };
  }

  let out;
  try {
    const got = await exportBytes(token, copyId, plan.mimeType);
    out = got.ok
      ? { ok: true, how: "convert", via: plan.via, exported_as: plan.mimeType, bytes: got.bytes, content_type: got.content_type }
      : { ...got, while: "export" };
  } catch (e) {
    out = { ok: false, while: "export", error: `The temporary copy could not be read back: ${(e?.message ?? String(e)).split("\n")[0]}` };
  }

  let gone;
  try { gone = await deleteFile(token, copyId); }
  catch (e) { gone = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
  return {
    ...out,
    temp_copy: { id: copyId, name: copyName(name), deleted: !!gone.ok, ...(gone.ok ? {} : { error: gone.error ?? "Drive did not say why" }) },
  };
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
