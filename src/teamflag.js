// "Can I flag this to Reason's team?" (team_flag, owner 2026-11-13).
//
// When something is left wrong that Reason cannot put right itself (a sign-out that never took, a
// payment that went out with no confirmation), it may offer to send a short report to Reason's team.
// Two steps, and code owns both:
//
//   propose  the model hands in a short factual report; code cleans and bounds it, stores THAT string
//            with a pending confirmation, and hands back the fixed words Reason says. Nothing is sent.
//   send     only through the confirm gate (src/tools.js needsConfirmation): their own typed yes to
//            that one ask, pinned to that one stored string. The text they saw goes to the operator's
//            thread, the same path the ops alerts take, and nothing else goes with it.
//
// What a report can hold is decided here, not asked for in a prompt: one paragraph, at most
// MAX_CHARS, no links, nothing card-, password- or code-like, no full phone number or email, no
// street address, and none of the names this person has on record for other people.
import { createHash, randomBytes } from "node:crypto";
import * as db from "./db.js";
import { config, clock } from "./config.js";
import * as restcrypt from "./restcrypt.js";
import { scrub as opsScrub } from "./opsdigest.js";
import { maskPhone, maskEmail } from "./logmask.js";
import { HIDDEN } from "./pagesecrets.js";
import * as callpass from "./callpass.js";

export const MAX_CHARS = 400;
export const MIN_CHARS = 20;
export const PER_DAY = 3;
/** Across everyone: the operator's thread is never flooded, whoever is sending. */
export const ALL_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60_000;
/** The first line of what the operator receives. */
export const HEADER = "Flag from a Reason user";
/** Idempotency-key prefix: under `ops:`, so the row is tagged an operator notice (db.OPS_KEY_PREFIXES). */
export const KEY_PREFIX = "ops:team-flag:";

/** The fixed words Reason says to offer it, around the exact text that would be sent. */
export const offerWords = (text) => `Can I flag this to Reason's team? I'd send: "${text}"`;

/**
 * The cue a failure's result carries (the endings listed in src/tools.js and src/accountjobs.js):
 * something new they can choose, never a retry, so nothing in it reads as "want me to try again".
 * `facts` is what the report would say, in Reason's own words; the model writes the report from them.
 */
export function offerCue(facts) {
  return `This is left wrong and you cannot put it right yourself. You may offer, once, to flag it to Reason's team:`
    + ` call team_flag with step "propose" and a short factual report (what they asked for, what happened, what is still wrong, what would fix it),`
    + ` then say back the words it returns, as they are. It is their choice; never send one they have not seen.`
    + (facts ? ` Facts for the report: ${String(facts).replace(/\s+/g, " ").trim().slice(0, 300)}` : "");
}

/**
 * "Forget my <site> login" (src/filler.js forgetLogin) that deleted the login but could not confirm the
 * sign-out on the site, or clear its session from Reason's browser: the extra fields for the tool's
 * result, with the cue. {} when it all took.
 */
export function forgetLeftover(site, out) {
  if (!out?.ok || !(Number(out.removed) > 0) || (out.signed_out !== false && out.cleared !== false)) return {};
  const name = String(site ?? "").toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  return {
    signed_out: !!out.signed_out, cleared: !!out.cleared,
    note: `After say_exactly: ${offerCue(`${name} may still be signed in after they asked to sign out and delete the saved login. The saved login was deleted; the sign-out on the site${out.cleared ? "" : " and clearing its session from Reason's browser"} could not be confirmed.`)}`,
  };
}

// ---------------------------------------------------------------- cleaning

const luhn = (d) => { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = d.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; };
// A card number as people write one: 13–19 digits in groups.
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
// A secret named and then given: "password is hunter2", "code: 482913", "PIN 1234", "CVC 123".
const NAMED_SECRET = /\b(password|passcode|passwd|pass ?phrase|pin(?: ?code| ?number)?|one[- ]time code|verification code|security code|access code|login code|sign[- ]in code|2fa code|otp|code|cvv|cvc2?|cid|token|api key|secret|recovery key|backup code)(\s*(?:is|was|=|:|->)?\s*)(["'`]?)([^\s"'`,;]{3,})\3/gi;
// What follows "password is" in a sentence about a problem, rather than the password itself.
const PLAIN_AFTER = new Set(["wrong", "incorrect", "invalid", "expired", "rejected", "accepted", "correct", "right", "required", "missing", "saved", "deleted", "removed", "changed", "reset", "still", "never", "not", "the", "and", "but", "did", "does", "didn't", "doesn't", "was", "were", "has", "had", "for", "from", "that", "this", "there", "sent", "arrived", "came", "worked", "failed", "stopped", "box", "field", "page", "screen", "manager", "change", "save", "login", "they", "them", "their", "which", "when", "after", "before", "again", "too", "also", "now", "then", "with", "without", "anymore", "empty", "blank", "shown", "asked", "needed", "only"]);
/** Is this the value of a secret rather than an ordinary word after one? */
const secretValue = (sep, raw) => {
  const v = raw.replace(/[.!?)]+$/, "");
  return /\d/.test(v) || /[^A-Za-z'’-]/.test(v) || /[:=]|->/.test(sep) || (/\b(?:is|was)\b/i.test(sep) && !PLAIN_AFTER.has(v.toLowerCase()));
};
// A long run that is a key or a token, not a word: 20+ letters and digits mixed.
const TOKEN = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;
// A bare one-time code: six to eight digits standing alone.
const LONE_CODE = /(?<![\d$.,:/-])\b\d{6,8}\b(?![\d.,:/-])/g;
// A bank account or routing number, named or not: any run of 9 to 17 digits (a phone number is masked
// before this, a card number hidden before it), and the value after "account/routing number".
const LONG_DIGITS = /(?<![\d…])\b\d(?:[ -]?\d){8,16}\b/g;
const BANK_NAMED = /\b(account|acct|routing|aba|iban|sort code|member)(\s*(?:number|no\.?|#))?(\s*(?:is|was|=|:|->|ending in|ends in)?\s*)([A-Z]{0,4}[\d][\d -]{3,}\d)/gi;
// Whatever follows "passphrase" (a call passphrase is plain words, so no shape gives it away): the rest of the sentence.
const PASSPHRASE_SAID = /\b(pass ?phrase|pass phrase)(\s*(?:is|was|=|:|->|of)?\s*)(["'“‘]?)([^.!?\n"”’]{2,120})/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// A phone number's shapes: +14155559876, (415) 555-9876, 415.555.9876, 415 555 9876.
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const URL = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S*/gi;
// A street address: a house number, one to four words, then the kind of street (and a unit after).
const STREET = /\b\d{1,6}\s+(?:[A-Z0-9][A-Za-z0-9'.-]*\s+){1,4}(?:St|ST|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Ter|Terrace|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Sq|Square)\b\.?(?:,?\s*(?:Apt|apt|Unit|unit|Suite|suite|Ste|#)\s*[\w-]+)?/g;

/** `+12025551234` → `…1234`, the visible part of the log mask (src/logmask.js) without its hash. */
const phoneMask = (m) => { const d = m.replace(/\D/g, ""); return d.length >= 10 ? `…${d.slice(-4)}` : m; };
/** `jane@icloud.com` → `j…@icloud.com`, the log mask's own shape without its hash. */
const emailMask = (m) => `${m[0]}…${m.slice(m.indexOf("@"))}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names this person has on record for other people (memory and their important people). */
export function namesOnRecord(conversationId) {
  const out = new Set();
  const add = (v) => {
    const s = String(restcrypt.openAny(v) ?? "").trim();
    if (s.length < 2 || /\d/.test(s)) return;
    out.add(s);
    // "Kofi Mensah" is also "Kofi" and "Mensah" in a sentence.
    for (const w of s.split(/\s+/)) if (w.length >= 3) out.add(w);
  };
  try { for (const r of db.db.prepare("SELECT name FROM people WHERE conversation_id = ?").all(conversationId)) add(r.name); } catch { /* none */ }
  try { for (const p of db.listImportantPeople(conversationId)) add(p.who); } catch { /* none */ }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * The report as it may be sent: one paragraph, no links, nothing secret, no full number or email, no
 * street address, no names of the people they have on record, at most MAX_CHARS. Pure but for the
 * names lookup. The same function makes what they are shown and what is stored; nothing remakes it.
 */
export function cleanReport(raw, { names = [] } = {}) {
  let t = String(raw ?? "").normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
  t = t.replace(URL, "[a link]");
  t = t.replace(PASSPHRASE_SAID, (m, word, sep, _q, v) => /^(?:is |was )?(?:wrong|incorrect|not (?:set|accepted|right)|missing|required|asked|needed|set)\b/i.test(v.trim()) && !/[:=]|->/.test(sep) ? m : `${word}${sep || " "}${HIDDEN}`);
  t = t.replace(NAMED_SECRET, (m, word, sep, _q, v) => secretValue(sep, v) ? `${word}${sep || " "}${HIDDEN}${(v.match(/[.!?)]+$/) ?? [""])[0]}` : m);
  t = t.replace(CARD, (m) => { const d = m.replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhn(d) ? HIDDEN : m; });
  t = t.replace(EMAIL, emailMask);
  t = t.replace(/\+\d{8,15}\b/g, phoneMask).replace(PHONE, phoneMask);
  t = t.replace(BANK_NAMED, (m, word, num, sep) => `${word}${num ?? ""}${sep || " "}${HIDDEN}`);
  t = t.replace(LONG_DIGITS, (m) => (m.replace(/\D/g, "").length >= 9 ? HIDDEN : m));
  t = t.replace(TOKEN, HIDDEN);
  t = t.replace(LONE_CODE, HIDDEN);
  t = t.replace(STREET, "[an address]");
  for (const n of names) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "giu"), "[someone]");
  // Their quotes would close the quote they are shown inside; one paragraph, single spaces.
  t = t.replace(/["“”]/g, "'").replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  if (t.length > MAX_CHARS) {
    const cut = t.slice(0, MAX_CHARS - 1);
    const at = cut.lastIndexOf(" ");
    t = `${(at > MAX_CHARS * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, "")}…`;
  }
  return t;
}

// ---------------------------------------------------------------- rows

const q = (sql) => db.db.prepare(sql);
const newRef = () => `TF-${randomBytes(4).toString("hex").toUpperCase().slice(0, 6)}`;
const rowOut = (r) => r ? { ...r, text: String(restcrypt.openAny(r.text) ?? "") } : null;

/** One flag of theirs, by its reference code. Never another person's. */
export function getFlag(conversationId, ref) {
  return rowOut(q("SELECT * FROM team_flags WHERE conversation_id = ? AND ref = ?").get(String(conversationId), String(ref ?? "").trim().toUpperCase()));
}

/** How many they have sent in the last day. */
export function sentToday(conversationId, now = clock.now()) {
  return q("SELECT COUNT(*) AS n FROM team_flags WHERE conversation_id = ? AND state = 'sent' AND sent_at > ?").get(String(conversationId), now - DAY_MS).n;
}

/**
 * What the confirm gate pins the yes to: the flag and the exact stored words (by their hash, so the
 * confirmations table never holds a second copy of the text). A yes to one report is never a yes to
 * another, or to the same flag with its words changed.
 */
export function flagTarget(ref, text) {
  return `team flag ${String(ref).toUpperCase()}: ${createHash("sha256").update(String(text)).digest("hex").slice(0, 16)}`;
}

/** The gate's target for a send, read off the stored row (tools.js confirmTargetFor). */
export function sendTarget(conversationId, ref) {
  const r = getFlag(conversationId, ref);
  return r ? flagTarget(r.ref, r.text) : `team flag ${String(ref ?? "").toUpperCase()}: none`;
}

/** Sent by anybody in the last day. */
export function sentByEveryone(now = clock.now()) {
  return q("SELECT COUNT(*) AS n FROM team_flags WHERE state = 'sent' AND sent_at > ?").get(now - DAY_MS).n;
}
const BUSY_WORDS = "Reason's team has had a lot of reports today, so this one can't be sent right now. Nothing was sent. Say so plainly in one line, and that they can flag it tomorrow if it is still wrong.";

/** Does the text hold their active call passphrase (src/callpass.js keeps only its hash)? */
export function holdsPassphrase(conversationId, text) {
  let rec = null;
  try { rec = callpass.activeFor(conversationId); } catch { return false; }
  if (!rec?.n) return false;
  const words = callpass.normalWords(text);
  const n = Number(rec.n);
  for (let i = 0; i + n <= words.length && i < 120; i++) {
    try { if (callpass.phraseMatches(words.slice(i, i + n).join(" "), rec)) return true; } catch { return false; }
  }
  return false;
}

/**
 * Were these exact words shown to them? The send goes only when one of Reason's own messages in this
 * turn's thread carried the stored text, so a yes is never a yes to words they did not see.
 */
export function wasShown(messages, text) {
  const norm = (v) => String(v ?? "").replace(/["“”'’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(text);
  if (!want) return false;
  const textOf = (m) => typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((b) => b?.text ?? "").join(" ") : "";
  return (Array.isArray(messages) ? messages : []).slice(-12).some((m) => m?.role === "assistant" && norm(textOf(m)).includes(want));
}

const LIMIT_WORDS = `They have already sent ${PER_DAY} reports to Reason's team today, which is the most there can be in a day. Nothing was sent.`
  + ` Say so kindly in one line, and that they can flag it tomorrow if it is still wrong. Do not offer anything else in its place.`;
const EVENT_WORDS = "A report to Reason's team can only come from a turn they started. Nothing was proposed and nothing was sent. Do not offer it now.";

// ---------------------------------------------------------------- the two steps

/**
 * Step 1. Clean and store the report, open the ask, and hand back the fixed words. Sends nothing.
 * An earlier proposal of theirs still open is closed: one report is on the table at a time.
 */
export function propose({ conversationId, report, kind = "event", ask }) {
  const c = String(conversationId);
  if (kind !== "user") return { ok: false, blocked: "not_their_turn", error: EVENT_WORDS };
  if (sentToday(c) >= PER_DAY) return { ok: false, blocked: "daily_limit", error: LIMIT_WORDS };
  if (sentByEveryone() >= ALL_PER_DAY) return { ok: false, blocked: "team_busy", error: BUSY_WORDS };
  const text = cleanReport(report, { names: namesOnRecord(c) });
  // Their call passphrase is never in a report, whatever words it is: every run of its length is checked against its hash.
  if (holdsPassphrase(c, text)) return { ok: false, blocked: "holds_secret", error: "That report would carry something secret of theirs. Nothing was proposed or sent. Write it again from the facts only, with no words they use to prove who they are." };
  if (text.replace(/\[[^\]]*\]|…/g, "").replace(/\W+/g, "").length < MIN_CHARS) {
    return { ok: false, blocked: "too_short", error: "That report says too little once cleaned. Write one or two plain sentences: what they asked for, what happened, what is still wrong, what would fix it. Nothing was proposed." };
  }
  const now = clock.now();
  q("UPDATE team_flags SET state = 'replaced' WHERE conversation_id = ? AND state = 'proposed'").run(c);
  // The ref is unique across everyone (the operator looks it up); a clash is retried, never read for.
  let ref = "", id = 0;
  for (let i = 0; i < 5 && !id; i++) {
    ref = newRef();
    try {
      id = Number(q("INSERT INTO team_flags (conversation_id, ref, text, state, created_at) VALUES (?, ?, ?, 'proposed', ?)")
        .run(c, ref, restcrypt.sealFor(c, text), now).lastInsertRowid);
    } catch (e) { if (!/UNIQUE/i.test(String(e?.message))) throw e; }
  }
  if (!id) return { ok: false, blocked: "no_ref", error: "Could not file the report just now. Nothing was proposed or sent." };
  const asked = ask({ summary: `Send a short report to Reason's team (flag ${ref}), in the exact words shown to them`, target: flagTarget(ref, text) });
  if (!asked?.ok) { q("UPDATE team_flags SET state = 'replaced' WHERE conversation_id = ? AND id = ?").run(c, id); return asked; }
  q("UPDATE team_flags SET confirmation_id = ? WHERE conversation_id = ? AND id = ?").run(asked.confirmation_id, c, id);
  return {
    ok: true, state: "waiting_for_yes", ref, confirmation_id: asked.confirmation_id, sent: false,
    say_exactly: offerWords(text),
    note: `Nothing has been sent. Say say_exactly to them as it is, on its own, and wait for their reply.`
      + ` If they say yes, call confirm_record with confirmation_id ${asked.confirmation_id}, then team_flag with step "send", ref "${ref}" and that confirmation_id.`
      + ` If they want different words, propose again with their change; if they say no, drop it.`,
  };
}

/** Who it is from, as the operator's texts may say it: never a full number or email, never a name. */
export function fromWords(conversationId) {
  const c = String(conversationId);
  if (c === config.ownerConversation) return "you (your own account)";
  let a = null;
  try { a = db.getAccount(c); } catch { /* none */ }
  if (a?.is_operator) return "you (your own account)";
  const addr = String(restcrypt.openAny(a?.address ?? "") ?? "").trim();
  if (/^\+\d{10,15}$/.test(addr)) return maskPhone(addr);
  if (EMAIL.test(addr)) { EMAIL.lastIndex = 0; return maskEmail(addr); }
  EMAIL.lastIndex = 0;
  return `account ${createHash("sha256").update(c).digest("hex").slice(0, 8)}`;
}

/** The one text the operator gets. The report is the stored text, as it was shown to them. */
export function operatorText({ conversationId, ref, text, at = clock.now() }) {
  const when = new Date(at).toLocaleString("en-US", { timeZone: config.installTz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  // Scrubbed the way every ops text is (src/opsdigest.js): the report was cleaned already; this is the second net.
  return opsScrub([HEADER, `From: ${fromWords(conversationId)}`, `At: ${when}`, `"${text}"`, `Ref: ${ref}`].join("\n"));
}

/**
 * Step 2, past the gate: the stored words, and only them, to the operator's thread. `spend` spends
 * the yes the moment the send is tried; `send(text, idempotencyKey)` is the ops path (runtime._tell /
 * say to config.ownerConversation as an operator notice). One row is sent once; a failed send is not
 * tried again by code, and the model is told not to either.
 */
export async function sendFlag({ conversationId, ref, confirmationId = null, kind = "event", send, spend = () => {}, messages = null }) {
  const c = String(conversationId);
  if (kind !== "user") return { ok: false, blocked: "not_their_turn", error: EVENT_WORDS };
  const row = getFlag(c, ref);
  if (!row) return { ok: false, blocked: "no_such_flag", error: `No flag ${ref} of theirs. Nothing was sent.` };
  if (row.state === "sent") return { ok: false, blocked: "already_sent", error: `Flag ${row.ref} was already sent to Reason's team. Nothing more was sent; say it has gone and the team will see it.` };
  if (row.state !== "proposed") return { ok: false, blocked: "not_open", error: `Flag ${row.ref} is no longer open (${row.state}). Nothing was sent. Do not send it again.` };
  if (confirmationId != null && row.confirmation_id != null && Number(confirmationId) !== Number(row.confirmation_id)) {
    return { ok: false, blocked: "wrong_confirmation", error: `Confirmation #${confirmationId} is not the ask for flag ${row.ref}. Nothing was sent.` };
  }
  if (sentToday(c) >= PER_DAY) return { ok: false, blocked: "daily_limit", error: LIMIT_WORDS };
  if (sentByEveryone() >= ALL_PER_DAY) return { ok: false, blocked: "team_busy", error: BUSY_WORDS };
  if (messages && !wasShown(messages, row.text)) {
    return { ok: false, blocked: "not_shown", error: `They have not been shown the exact words of flag ${row.ref}. Nothing was sent. Say this to them as it is, and wait for their yes: ${offerWords(row.text)}` };
  }
  if (typeof send !== "function") return { ok: false, blocked: "no_sender", error: "Reason's team cannot be reached from here right now. Nothing was sent. Say so plainly; do not try again." };
  const at = clock.now();
  // Claimed before the send, so two calls in one turn cannot both go.
  if (q("UPDATE team_flags SET state = 'sending' WHERE conversation_id = ? AND id = ? AND state = 'proposed'").run(c, row.id).changes !== 1) {
    return { ok: false, blocked: "not_open", error: `Flag ${row.ref} is already being sent. Nothing more was sent.` };
  }
  spend();
  let delivered = true;
  try {
    const out = await send(operatorText({ conversationId: c, ref: row.ref, text: row.text, at }), `${KEY_PREFIX}${row.ref}`);
    if (out && out.ok === false) delivered = false;
  } catch { delivered = false; }
  q("UPDATE team_flags SET state = ?, sent_at = ? WHERE conversation_id = ? AND id = ?").run(delivered ? "sent" : "send_failed", delivered ? at : null, c, row.id);
  if (!delivered) {
    return { ok: false, blocked: "send_failed", ref: row.ref, error: `The report could not be handed to Reason's team. Say so plainly in one line. Do not send it again on your own.` };
  }
  return {
    ok: true, sent: true, ref: row.ref,
    note: `Sent. Tell them plainly, in one line, that it has gone to Reason's team and the team will see it. Do not promise a reply or say when.`,
  };
}
