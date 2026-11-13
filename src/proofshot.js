// A picture of the page as proof: when Reason finishes something on a website in its OWN browser (a
// bill paid or a plan cancelled while signed in there with a saved login, an errand on a page it
// opened), ONE picture of the page that shows it, sent to the person's own thread with the result
// line, and kept with them as the proof.
//
// Why (owner, 2026-11-13): another assistant sent him the billing page ("Your subscription is set to
// cancel on Nov 27, 2026", the plan, the last invoice) and that picture was the most useful part of
// the answer: "all the relevant things that would be helpful if they saw it too".
//
// What it cannot do: an account job that runs on Crossmint's Agent Checkouts (src/accountjobs.js).
// Crossmint's browser is theirs, and their API returns no picture of a run: a run is `status`,
// `result.summary` in words and `run.browser.embedUrl`, "a read-only live view of the browser" while
// a session exists (docs.crossmint.com agents/checkouts/how-it-works and follow-run, read
// 2026-11-13). No screenshot, artifact or recording field is documented. Those jobs keep the page's
// own line, quoted (account_jobs.page_line), and no picture: nothing here draws one.
//
// The rules, each enforced in code and tested (test/proofshot.test.js):
//   - Only this conversation's own browser page (browser.pageFor), sent only to this conversation's own
//     thread (its address and chat from the thread row, never from the model).
//   - Never a sign-in page, and never a page showing a secret box (a password, a one-time code, a card
//     number or code box: src/pagesecrets.js kind()). Refused, not masked; every box is masked anyway.
//   - Never a page whose visible words hold a full card number (a Luhn-valid 13-19 digit run), a card
//     code, or a bank account or routing number: refused. Last 4 as the page prints it is fine.
//   - Cropped to the section that holds the line it proves when the page has one; else the viewport,
//     never the whole scrolled page. JPEG, capped (MAX_BYTES, MAX_SIDE).
//   - Sealed per person (REASON_ENCRYPT_REST2) and on their record (proof_pictures, conversation_files):
//     an export carries it, a delete unlinks it (src/data.js), and nobody else's turn can open it.
//   - It is evidence for the person: the tool's result carries no page words and no image back to the
//     model, so nothing on the picture can steer it.
import { mkdirSync, statSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import * as db from "./db.js";
import { config, clock } from "./config.js";
import { shotPrefix } from "./ownfiles.js";
import { sealInPlace, readPlain } from "./restfiles.js";
import { inPage } from "./pagesecrets.js";

export const MAX_BYTES = 1_500_000;
export const MAX_SIDE = 1600;
export const QUALITY = 70;

db.db.exec(`CREATE TABLE IF NOT EXISTS proof_pictures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  file TEXT NOT NULL,
  host TEXT NOT NULL DEFAULT '',
  what TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS proof_pictures_by_conv ON proof_pictures (conversation_id, at);`);
const q = (sql) => db.db.prepare(sql);
const short = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// ---------------------------------------------------------------- what a page may not be
const SIGNIN_PATH = /(^|[/._-])(log-?in|sign-?in|signin|sign_in|auth(enticate|orize)?|sso|password|passwd|reset|verify|verification|otp|2fa|mfa|challenge|one-?time)([/._-]|$)/i;
const SIGNIN_TITLE = /\b(sign ?in|log ?in|enter (your )?(password|code)|verification code|two-?factor|one-?time (pass)?code)\b/i;
/** A full card number in words: a 13-19 digit run (spaces or dashes allowed) that passes Luhn. */
export function hasCardNumber(text) {
  for (const m of String(text ?? "").matchAll(/(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length < 13 || d.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
const CARD_CODE = /\b(cvc|cvv|cvv2|csc|security code|card code)\b\W{0,6}\d{3,4}\b/i;
const BANK_NUMBER = /\b(routing( number)?|aba|iban|bank account( number)?|checking( account)?|savings( account)?|account no\.? ?\(bank\))\b\W{0,12}[A-Z]{0,4}\d[\d ]{5,}/i;
/** Why these visible words may not be in a picture, or "". */
export function wordsRefused(text) {
  if (hasCardNumber(text)) return "card_number";
  if (CARD_CODE.test(String(text ?? ""))) return "card_code";
  if (BANK_NUMBER.test(String(text ?? ""))) return "bank_number";
  return "";
}
/** Is this address or title a sign-in page's? */
export function isSigninPage(url, title = "") {
  let u;
  try { u = new URL(String(url)); } catch { return true; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return true;
  return SIGNIN_PATH.test(u.pathname) || SIGNIN_PATH.test(u.hostname.split(".")[0]) || SIGNIN_TITLE.test(String(title ?? ""));
}

// Reads the page once: visible secret boxes (pagesecrets' own rules), the visible words, and marks the
// section that holds the line to prove (data-reason-proof) when there is one of a sane size.
const INSPECT = inPage((S, focus) => {
  const shown = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  let secrets = 0;
  for (const el of document.querySelectorAll("input, textarea, select")) {
    const k = S.kind(el);
    if (k) el.setAttribute("data-reason-secret", "1"); else el.removeAttribute("data-reason-secret");
    if (k && shown(el)) secrets++;
  }
  for (const el of document.querySelectorAll("[data-reason-proof]")) el.removeAttribute("data-reason-proof");
  const words = (document.body && document.body.innerText) || "";
  let section = false;
  const want = String(focus || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (want.length >= 6 && document.body) {
    let best = null, bestLen = Infinity;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = (n.innerText || "").toLowerCase().replace(/\s+/g, " ");
      if (t.length < bestLen && t.includes(want)) { best = n; bestLen = t.length; }
    }
    // Up to the block around it (the plan, its invoice, its line), never past a screen and a half.
    let box = best;
    while (box && box.parentElement && box.parentElement !== document.body && box.getBoundingClientRect().height < 260 && box.parentElement.getBoundingClientRect().height <= 1400) box = box.parentElement;
    if (box && shown(box)) {
      const r = box.getBoundingClientRect();
      if (r.height <= 1600 && r.width <= 1600) { box.setAttribute("data-reason-proof", "1"); section = true; }
    }
  }
  return { secrets, words: words.slice(0, 200000), section, title: document.title || "" };
});

/**
 * One picture of this page as proof, kept on their record.
 *   → { ok: true, id, file, bytes, cropped } | { ok: false, refused: "sign_in_page" | "secret_box" |
 *     "card_number" | "card_code" | "bank_number" | "blank" | "too_big" | "failed" }
 */
export async function captureProof(conversationId, page, { focus = "", what = "" } = {}) {
  if (!conversationId || !page) return { ok: false, refused: "failed" };
  const url = String(page.url?.() ?? "");
  if (!url || url === "about:blank") return { ok: false, refused: "blank" };
  let look;
  try { look = await page.evaluate(INSPECT, String(focus ?? "")); } catch { return { ok: false, refused: "failed" }; }
  if (isSigninPage(url, look.title)) return { ok: false, refused: "sign_in_page" };
  if (look.secrets > 0) return { ok: false, refused: "secret_box" };
  const why = wordsRefused(look.words);
  if (why) return { ok: false, refused: why };
  const file = resolve(join(config.shotRoot, `${shotPrefix(conversationId)}proof-${clock.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`));
  mkdirSync(dirname(file), { recursive: true });
  const mask = [page.locator("[data-reason-secret]")];
  const opts = { path: file, type: "jpeg", quality: QUALITY, mask, maskColor: "#888888", animations: "disabled" };
  try {
    if (look.section) await page.locator("[data-reason-proof]").first().screenshot({ ...opts, timeout: 10_000 });
    else {
      const v = page.viewportSize?.() ?? { width: 1280, height: 900 };
      await page.screenshot({ ...opts, clip: { x: 0, y: 0, width: Math.min(v.width, MAX_SIDE), height: Math.min(v.height, MAX_SIDE) } });
    }
  } catch { try { if (existsSync(file)) unlinkSync(file); } catch { /* nothing kept */ } return { ok: false, refused: "failed" }; }
  const bytes = statSync(file).size;
  if (bytes > MAX_BYTES) { try { unlinkSync(file); } catch { /* gone either way */ } return { ok: false, refused: "too_big" }; }
  sealInPlace(file, conversationId);
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* none */ }
  const id = Number(q("INSERT INTO proof_pictures (conversation_id, file, host, what, bytes, at) VALUES (?, ?, ?, ?, ?, ?)").run(conversationId, file, host, short(what, 160), bytes, clock.now()).lastInsertRowid);
  // Theirs on the file record too (src/ownfiles.js), so it is sendable in their thread and nobody else's.
  q("INSERT OR IGNORE INTO conversation_files (conversation_id, path, at) VALUES (?, ?, ?)").run(conversationId, file, clock.now());
  return { ok: true, id, file, bytes, cropped: !!look.section };
}

/** A proof picture of THIS conversation, or null: another person's id is never found. */
export const proofRow = (conversationId, id) => q("SELECT * FROM proof_pictures WHERE conversation_id = ? AND id = ?").get(String(conversationId), Number(id)) ?? null;
/** Its plain bytes, for this conversation only. */
export function proofBytes(conversationId, id) {
  const row = proofRow(conversationId, id);
  if (!row) return null;
  try { return readPlain(row.file); } catch { return null; }
}
export const markSent = (conversationId, id) => q("UPDATE proof_pictures SET sent = 1 WHERE conversation_id = ? AND id = ?").run(String(conversationId), Number(id));
export const proofsFor = (conversationId) => q("SELECT * FROM proof_pictures WHERE conversation_id = ? ORDER BY id").all(String(conversationId));

/** For an export (src/data.js): each picture with its bytes when `files`, said missing when it is not on disk. */
export function exportProofs(conversationId, { files = true } = {}) {
  return proofsFor(conversationId).map((r) => {
    let b = null;
    if (files) { try { b = readPlain(r.file); } catch { b = null; } }
    return { id: r.id, host: r.host, what: r.what, at: r.at, mime: "image/jpeg", ...(files ? { missing: b === null } : {}), ...(b ? { file_base64: b.toString("base64") } : {}) };
  });
}
/** The files a delete unlinks (src/data.js): listed while the rows still name them. */
export function proofFilesFor(conversationId) {
  return (conversationId ? q("SELECT file FROM proof_pictures WHERE conversation_id = ?").all(conversationId) : q("SELECT file FROM proof_pictures").all()).map((r) => r.file);
}

/** The retention sweep (src/privacy.js, REASON_KEEP_CONTENT_DAYS): pictures older than `before` go, the file first, then its row. */
export function pruneProofs(before, log = () => {}) {
  let gone = 0;
  for (const r of q("SELECT id, conversation_id, file FROM proof_pictures WHERE at < ?").all(before)) {
    try { rmSync(r.file, { force: true }); } catch (e) { log({ retention_proof_failed: r.id, why: String(e?.message ?? e).split("\n")[0] }); continue; }
    q("DELETE FROM proof_pictures WHERE conversation_id = ? AND id = ?").run(r.conversation_id, r.id);
    q("DELETE FROM conversation_files WHERE conversation_id = ? AND path = ?").run(r.conversation_id, r.file);
    gone++;
  }
  return gone;
}
/** Why a picture was not taken, in one plain line for the person (never the page's words). */
export function refusedLine(why) {
  switch (why) {
    case "sign_in_page": return "I didn't take a picture: that's a sign-in page.";
    case "secret_box": return "I didn't take a picture: the page has a password, code or card box on it.";
    case "card_number": case "card_code": case "bank_number": return "I didn't take a picture: the page shows a full card or bank number.";
    case "blank": return "I didn't take a picture: no page is open.";
    case "too_big": return "I didn't take a picture: it came out too large to send.";
    default: return "I couldn't take a picture of the page.";
  }
}
