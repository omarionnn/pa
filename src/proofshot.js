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
//   - Only when it helps them check something (PICTURE_FOR: a cancellation notice, a paid receipt, a changed
//     plan, a confirmation number, a site's error); a routine success is text only. One per result.
//   - Cropped to the block holding the line it proves, never the screen or the whole page; a block that
//     cannot be found, or cannot be cut clear of card rows, invoices, amounts, addresses and email
//     addresses, means no picture (a bill's amount paid and confirmation number are its claim, so kept).
//     JPEG, capped (MAX_BYTES, MAX_SIDE).
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

// ---------------------------------------------------------------- when a picture helps
// The owner's rule (2026-11-13): "I send a picture when it helps you check something, compare options, or
// see what I'm referring to. Otherwise, text is enough." So a picture goes only for something the person
// can CHECK on it; everything else is text. Anything not in this table is text only.
export const PICTURE_FOR = Object.freeze({
  cancellation: "a cancellation notice (cancelled, or set to end on a date)",
  payment: "a paid / receipt confirmation: the amount paid and its confirmation number",
  plan_change: "a changed plan as the page now shows it",
  confirmation_number: "a confirmation or booking number",
  site_error: "an error the site showed",
});
export const TEXT_ONLY = Object.freeze(["signed_in", "loading", "status", "other"]);
/** Does a picture help for this? Unsure is no. */
export const pictureHelps = (proves) => Object.hasOwn(PICTURE_FOR, String(proves ?? ""));
/** An account job's ending → what its picture would prove, or null for text only (default). */
export function pictureForJob({ kind, outcome } = {}) {
  if (outcome === "site_error") return "site_error";
  if (kind === "cancel" && ["done", "done_result_only", "already_done", "waiting_mail"].includes(outcome)) return "cancellation";
  if (kind === "bill" && ["done", "done_result_only", "already_done", "waiting_mail"].includes(outcome)) return "payment";
  return null;
}

// Reads the page once: visible secret boxes (pagesecrets' own rules), the visible words, and the crop:
// the smallest element holding the proving line, grown toward its section only while what it adds holds
// nothing to keep out (a card row, an invoice list or amount, an address, an email address), then a
// little padding that may not touch any such row. No such element, or no clean crop: no picture.
const INSPECT = inPage((S, arg) => {
  const { focus, bill } = arg || {};
  const shown = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  let secrets = 0;
  for (const el of document.querySelectorAll("input, textarea, select")) {
    const k = S.kind(el);
    if (k) el.setAttribute("data-reason-secret", "1"); else el.removeAttribute("data-reason-secret");
    if (k && shown(el)) secrets++;
  }
  const words = (document.body && document.body.innerText) || "";
  const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(focus);
  const out = { secrets, words: words.slice(0, 200000), title: document.title || "", clip: null, why: "" };
  if (want.length < 6 || !document.body) { out.why = "no_line"; return out; }
  // What is kept out of a crop. For a bill paid, the amount and the confirmation number ARE the claim.
  const KEEP_OUT = [
    /\b(visa|mastercard|master card|amex|american express|discover|diners|jcb|unionpay|debit|credit card|card)\b[^\n]{0,24}?(ending|ends|•|\*{2,}|x{2,}|…)\s*(in\s*)?\d{4}\b/i,
    /(•{2,}|\*{2,}|x{4,})\s*\d{4}\b/i,
    /\bpayment (method|details|info(rmation)?|card)s?\b/i,
    /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
    /\b\d{1,6}\s+[a-z0-9.' ]{2,30}\s(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl)\b/i,
    /\b(billing|shipping|mailing|home) address\b/i,
  ];
  if (!bill) KEEP_OUT.push(/\binvoices?\b|\bbilling history\b|\bpayment history\b/i, /[$€£]\s?\d/);
  const dirty = (text) => { const t = norm(text).split(want).join(" "); return KEEP_OUT.some((re) => re.test(t)); };
  let best = null, bestLen = Infinity;
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = norm(n.innerText);
    if (t.length < bestLen && t.includes(want) && shown(n)) { best = n; bestLen = t.length; }
  }
  if (!best) { out.why = "not_located"; return out; }
  if (dirty(best.innerText)) { out.why = "kept_out"; return out; }
  let box = best;
  while (box.parentElement && box.parentElement !== document.body && box.parentElement !== document.documentElement) {
    const up = box.parentElement;
    const r = up.getBoundingClientRect();
    if (r.height > 600 || r.width > 1400 || dirty(up.innerText)) break;
    box = up;
  }
  box.scrollIntoView({ block: "center" });
  const r = box.getBoundingClientRect();
  // Every element holding something kept out: the crop may not touch it.
  const bad = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (box.contains(el) || el.contains(box) || !shown(el)) continue;
    if (el.children.length > 8) continue;
    if (KEEP_OUT.some((re) => re.test(norm(el.innerText)))) bad.push(el.getBoundingClientRect());
  }
  const hits = (c) => bad.some((b) => b.left < c.x + c.width && b.right > c.x && b.top < c.y + c.height && b.bottom > c.y);
  const vw = window.innerWidth, vh = window.innerHeight;
  for (const pad of [12, 6, 0]) {
    const x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad);
    const c = { x, y, width: Math.min(vw, r.right + pad) - x, height: Math.min(vh, r.bottom + pad) - y };
    if (c.width < 20 || c.height < 10) continue;
    if (!hits(c)) { out.clip = c; break; }
  }
  if (!out.clip) out.why = "kept_out";
  return out;
});

/**
 * One picture of the part of the page that proves it, kept on their record.
 *   proves — a PICTURE_FOR key; anything else is text only (refused: "text_only")
 *   focus  — the page's own line the result quotes; the crop is built around it, and without it no picture
 *   → { ok: true, id, file, bytes, clip } | { ok: false, refused: "text_only" | "sign_in_page" | "secret_box" |
 *     "card_number" | "card_code" | "bank_number" | "blank" | "no_line" | "not_located" | "kept_out" | "too_big" | "failed" }
 */
export async function captureProof(conversationId, page, { proves = "", focus = "", what = "" } = {}) {
  if (!conversationId || !page) return { ok: false, refused: "failed" };
  if (!pictureHelps(proves)) return { ok: false, refused: "text_only" };
  const url = String(page.url?.() ?? "");
  if (!url || url === "about:blank") return { ok: false, refused: "blank" };
  let look;
  try { look = await page.evaluate(INSPECT, { focus: String(focus ?? ""), bill: proves === "payment" }); } catch { return { ok: false, refused: "failed" }; }
  if (isSigninPage(url, look.title)) return { ok: false, refused: "sign_in_page" };
  if (look.secrets > 0) return { ok: false, refused: "secret_box" };
  const why = wordsRefused(look.words);
  if (why) return { ok: false, refused: why };
  // Never the whole page, never the screen: the proving block, or nothing.
  if (!look.clip) return { ok: false, refused: look.why || "not_located" };
  const clip = { x: Math.round(look.clip.x), y: Math.round(look.clip.y), width: Math.min(MAX_SIDE, Math.round(look.clip.width)), height: Math.min(MAX_SIDE, Math.round(look.clip.height)) };
  const file = resolve(join(config.shotRoot, `${shotPrefix(conversationId)}proof-${clock.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`));
  mkdirSync(dirname(file), { recursive: true });
  try {
    await page.screenshot({ path: file, type: "jpeg", quality: QUALITY, mask: [page.locator("[data-reason-secret]")], maskColor: "#888888", animations: "disabled", clip });
  } catch { try { if (existsSync(file)) unlinkSync(file); } catch { /* nothing kept */ } return { ok: false, refused: "failed" }; }
  const bytes = statSync(file).size;
  if (bytes > MAX_BYTES) { try { unlinkSync(file); } catch { /* gone either way */ } return { ok: false, refused: "too_big" }; }
  sealInPlace(file, conversationId);
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* none */ }
  const id = Number(q("INSERT INTO proof_pictures (conversation_id, file, host, what, bytes, at) VALUES (?, ?, ?, ?, ?, ?)").run(conversationId, file, host, short(what, 160), bytes, clock.now()).lastInsertRowid);
  // Theirs on the file record too (src/ownfiles.js), so it is sendable in their thread and nobody else's.
  q("INSERT OR IGNORE INTO conversation_files (conversation_id, path, at) VALUES (?, ?, ?)").run(conversationId, file, clock.now());
  return { ok: true, id, file, bytes, clip };
}
/** One picture per result: one already sent to them in the last few minutes means this result already has its picture. */
export const ONE_PER_RESULT_MS = 5 * 60_000;
export const sentRecently = (conversationId, now = clock.now()) => !!q("SELECT 1 FROM proof_pictures WHERE conversation_id = ? AND sent = 1 AND at > ?").get(String(conversationId), now - ONE_PER_RESULT_MS);

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
    case "text_only": return "";
    case "no_line": case "not_located": return "I didn't send a picture: I couldn't find the exact part of the page that shows it.";
    case "kept_out": return "I didn't send a picture: that part of the page sits right against your payment or invoice details.";
    case "too_big": return "I didn't take a picture: it came out too large to send.";
    default: return "I couldn't take a picture of the page.";
  }
}
