// When it fails, hand back the furthest point it got to.
//
// Omari's line, 2026-10-06: "when it fails, it should hand back the furthest point it got to, like a
// filled-in checkout that just needs your tap or a ready draft, never a plain 'couldn't do it'."
//
// The failure this exists for is not a failure at all, it is a hand-off that never happened. Reason
// drives a booking to the last button, fills in the name and the number, and then cannot press it —
// because the gate is working, or because the site refuses an automated browser, or because nobody
// answered the one question. All of that work exists. It is sitting in a browser on somebody's Mac,
// one tap from done, and the message that goes out says "couldn't get that booked". The person
// starts from nothing on a job that was finished except for the tap.
//
// So the record is on the sheet (`sheet.furthest`, written in src/sheet.js) and the hand-back is
// enforced in **code**, not asked for in the prompt:
//
//   - A job that shows progress may not be closed `failed`, and may not be set `blocked`, until the
//     sheet carries a furthest point. One tool call clears it, and the refusal says which.
//   - When a browser walk stops — the commit click the gate will not press, a click a site refuses —
//     the URL it reached and what is already filled on the page are read off the page by code and
//     written down. The model does not get to decide whether that happened.
//
// What code cannot do is make the reply lead with it: a reply is words, and words are the model's.
// What code does is refuse the close, put the point in front of the model on every turn the job is
// open (`sheetView`), and show it on the open-work page. See docs/unverified.md.
//
// Nothing here reads anybody's words to decide what they meant. `progressOn` reads sheet rows,
// `filledFrom` reads a DOM snapshot's own values, and `linkCarries` compares two strings.
import { parseSheet, latestFurthest } from "./sheet.js";
import { looksLikeACredential } from "./privacy.js";

/**
 * What this job has actually produced, as lines, from rows alone.
 *
 * This is the test for "was there progress to hand back". It is deliberately not "did anything
 * happen" — a job that tried three sites and got nothing has nothing to hand over, and "couldn't do
 * it, here's what I tried" is the honest answer to that one. What counts is something that EXISTS
 * now: a candidate with a link, a price with its page, terms that were read, a decision taken, or
 * something code watched get made (`made`, built from the ledger rows carrying this task's id).
 *
 * An empty list means a bare failure is honest, and nothing below stands in its way.
 */
export function progressOn(sheet, { made = [] } = {}) {
  const s = parseSheet(sheet);
  const out = [];
  const withLinks = s.options.filter(o => o.status !== "rejected" && o.where);
  if (withLinks.length) out.push(`${withLinks.length} option(s) you gathered, each with the page it is on`);
  if (s.prices.length) out.push(`${s.prices.length} price(s) you found, with where you saw each one`);
  if (s.document) out.push(`the terms you read (${s.document.what})`);
  if (s.decisions.length) out.push(`${s.decisions.length} decision(s) already taken on it`);
  for (const m of made) {
    const line = String(m ?? "").trim();
    if (line) out.push(line);
  }
  return out;
}

/** The ledger actions that leave something behind for them, rather than something that went out. */
const MADE_SOMETHING = {
  page_create: "a page you made for them",
  page_update: "a page you made for them",
  gmail_draft: "a draft sitting in their Gmail",
  drive_create: "a document you put in their Drive",
};

/**
 * Ledger rows for one job, as the lines `progressOn` takes.
 *
 * Only the rows that left something behind. A text that went out is not a furthest point — it
 * happened — and a row for an attempt that failed produced nothing. Deduplicated, because editing
 * one page four times is one page.
 */
export function madeFrom(rows = []) {
  const seen = new Set();
  for (const r of rows) {
    const line = MADE_SOMETHING[r?.action];
    if (line) seen.add(line);
  }
  return [...seen];
}

/**
 * May this job be given up on with nothing handed back? `null` when yes, a refusal when no.
 *
 * `closing` is the word being used — "failed" or "blocked" — so the refusal talks about the thing
 * the model is actually trying to do. The way past it is one call, and the refusal says exactly
 * which, because a refusal that does not name its own way out is a dead end.
 */
export function handBackNeeded({ sheet, made = [], closing = "failed", taskId = null } = {}) {
  const made_lines = progressOn(sheet, { made });
  if (!made_lines.length) return null;
  if (latestFurthest(sheet)) return null;
  const job = taskId ? `Task #${taskId}` : "This job";
  return {
    ok: false, blocked: "no_furthest_point", progress: made_lines,
    error: `${job} got somewhere — ${made_lines.join("; ")} — and you are about to call it ${closing} with none of it handed over.`
      + ` A plain "couldn't do it" throws that away and starts them from nothing on a job that is mostly done.`
      + ` Nothing was written. Hand the furthest point back first: task_update with sheet.furthest —`
      + ` what you reached, the form it is in, the link if there is one they can open, what is already filled in,`
      + ` the ONE thing left for them to do, and why you stopped. Then call this again.`
      + ` If what you reached genuinely cannot be handed over — nothing exists outside a session that is gone —`
      + ` say that in the outcome in those words, and record it as a furthest point of form 'partial' with what you found so far.`,
  };
}

// ---------- what a stopped browser walk leaves behind ----------

// Fields whose value is nobody's business, whatever a page calls them. A password box is never
// something Reason filled (it does not take passwords at all), and a card field is the one thing
// that must not end up in a row somebody reads back later.
const NEVER_RECORDED = /^(password|hidden|file)$/i;
const SENSITIVE_FIELD = /\b(card|cvv|cvc|security\s*code|pin|password|passcode|ssn|social\s*security|account\s*number|routing)\b/i;

/**
 * What is already filled in on the page, read off the snapshot's own values.
 *
 * Read from the DOM rather than from a memory of having typed, which is the difference between
 * "what is on the screen" and "what I think I did". `snapshot` in src/browser.js already carries
 * each input's real `value`, and a hidden input is not in it at all (it has no size, so it is not
 * visible) — so a GET form's machinery does not turn up here as something the person filled.
 *
 * A value that looks like a credential is recorded as filled with its value withheld: that a card
 * number is in the box is the thing they need to know; the digits are not.
 */
export function filledFrom(elements = []) {
  const out = [];
  for (const el of elements) {
    if (!el || !["input", "textarea", "select"].includes(el.tag)) continue;
    if (NEVER_RECORDED.test(String(el.type ?? ""))) continue;
    const value = String(el.value ?? "").trim();
    if (!value) continue;
    const field = String(el.name ?? el.ref ?? "").replace(/\s+/g, " ").trim() || String(el.type || el.tag);
    const sensitive = SENSITIVE_FIELD.test(field) || !!looksLikeACredential(value);
    out.push({ field, value: sensitive ? "(filled in — not written down)" : value.slice(0, 120) });
  }
  return out;
}

/**
 * Is this an address they could open themselves? And does it carry what is filled?
 *
 * Two different questions and both get answered, because handing back a link as though it carried
 * the filled form would be a promise the link cannot keep. A name typed into a box is in the DOM
 * and not in the URL, so the link reopens the right PAGE and nothing more — and that is what the
 * person is told. Mechanical: a filled value is carried only if it really is in the address.
 */
export function shareable(url, filled = []) {
  let u;
  try { u = new URL(String(url ?? "")); } catch { return { shareable: false, why: "there is no address for where it got to" }; }
  if (!["http:", "https:"].includes(u.protocol)) return { shareable: false, why: "where it got to is not an http address" };
  const deep = u.pathname.replace(/\/+$/, "") !== "" || !!u.search;
  if (!deep) return { shareable: false, why: "the only address is the site's front page, which is not where it got to" };
  const haystack = `${u.pathname}?${u.search}`.toLowerCase();
  const carries = filled.filter(f => f.value && !f.value.startsWith("(") && haystack.includes(f.value.toLowerCase())).map(f => f.field);
  return {
    shareable: true, url: u.href, carries,
    why: filled.length === 0
      ? "the address opens the page it got to"
      : carries.length === filled.length
        ? "the address carries everything that is filled in"
        : `the address opens the right page, but ${filled.length - carries.length} of the ${filled.length} filled field(s) were typed in and are NOT in it`,
  };
}

/**
 * The record for a walk that stopped, from what the page says. Code's, not the model's.
 *
 * Returns the object `sheet.furthest` takes, or null when there is nothing worth handing back —
 * no address, and nothing filled in, is a walk that got nowhere.
 */
export function fromWalk({ url, elements = [], oneAction = "", stopped = "other", because = "" } = {}) {
  const filled = filledFrom(elements);
  const link = shareable(url, filled);
  if (!link.shareable && !filled.length) return null;
  const action = String(oneAction ?? "").trim();
  const what = filled.length
    ? `the form on ${hostOf(url)} with ${filled.length} field(s) filled in${link.shareable ? `, at ${link.url}` : ""}`
    : `the page it reached on ${hostOf(url)}${link.shareable ? `, at ${link.url}` : ""}`;
  return {
    form: filled.length ? "filled_form" : "saved_state",
    what,
    ...(link.shareable ? { where: link.url, where_known: "browser_reached" } : {}),
    filled,
    one_action: action || (filled.length ? "open it and finish the last step yourself" : "open it and carry on from there"),
    stopped,
    because: String(because ?? "").trim() || "the walk stopped here",
    // Not part of the sheet record — handed back in the tool result so the model is told, in the
    // same breath, what the link does and does not carry.
    link,
  };
}

const hostOf = (url) => { try { return new URL(String(url)).host; } catch { return "that site"; } };

/**
 * The line the model is handed with a stopped walk: what exists, and the one thing left.
 *
 * Here rather than in src/tools.js so the two places a walk can stop — the commit the gate will not
 * press, and a step the site refuses — say the same thing about it.
 */
export function walkNote(record, { taskId = null } = {}) {
  if (!record) return "Nothing on that page was filled in and there is no address for it, so there is no furthest point to hand back.";
  const filled = record.filled.length
    ? `${record.filled.length} field(s) are filled in (${record.filled.map(f => f.field).join(", ")})`
    : "nothing is filled in yet";
  return `This is as far as it goes on its own, and what it reached is real: ${filled}.`
    + (record.where
      ? ` ${record.link.carries.length === record.filled.length && record.filled.length
        ? `That address carries what is filled, so it is the hand-back: send it with the one action on it.`
        : `The address ${record.where} opens that page, but what was typed into the form is NOT in it — so say what is filled and what the one tap is, and send the link as the page rather than as the filled form.`}`
      : ` There is no address they can open, so the hand-back is in words: say what is filled and what the one action is.`)
    + ` Lead with that and with "${record.one_action}" — not with an apology, and not with less than this.`
    + (taskId
      ? ` It is written on task #${taskId}, so it survives a restart and comes back to you on every wake.`
      : ` NOTHING has written this down: if this belongs to a job, record it with task_update's sheet.furthest before you reply, or it is gone when this turn ends.`);
}
