// Reason checking its own work, so nobody else has to.
//
// Omari's line is "I shouldn't be quality control". Four things are worth checking and all four fail
// quietly without a check: a link that does not open, a total that quietly dropped the fees they
// asked to have included, a message aimed at somebody who is not on the job, and a page that was
// made but does not render. Each one is a refusal here rather than an apology later.
//
// Every check takes facts and returns `{ ok: true, … }` or `{ ok: false, error }` that the caller
// hands back as it is. None of them reads anything a person wrote to decide what it meant: the link
// is fetched, the total is a string Reason itself composed, the recipient is compared against names
// already on the sheet, and the page is rendered by the same code that serves it.
import { webLookup } from "./weblookup.js";
import { renderPage } from "./pages/render.js";
import { parseSheet, peopleOn } from "./sheet.js";
import { normalizeNumber } from "./config.js";

/**
 * A link Reason is about to send, fetched once. Must answer 2xx.
 *
 * The failure this stops is the small, common, trust-destroying one: a link that 404s in the
 * message that promised it worked. A failing link is **reported as failing**, never sent as if it
 * were fine — and reported with the real status, because "that page is gone" and "that site would
 * not answer me" are different things to be told.
 *
 * `lookup` is injectable so a test can state what the web did.
 */
export async function verifyLink(url, { lookup = webLookup } = {}) {
  let parsed;
  try { parsed = new URL(String(url ?? "")); } catch {
    return { ok: false, error: `'${url}' is not a link. Do not send it.` };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: `'${url}' is not an http or https link. Do not send it.` };
  }
  let out;
  try { out = await lookup(parsed.href, { maxChars: 500 }); }
  catch (e) { out = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }

  if (out?.ok) return { ok: true, url: out.url ?? parsed.href, status: out.status ?? 200, title: out.title ?? "" };
  // A page that answered but is not readable text — a PDF, an image — is still a page that opens,
  // and this check is about whether the link works, not about whether Reason can read it.
  if (out?.status && out.status >= 200 && out.status < 300) {
    return { ok: true, url: out.url ?? parsed.href, status: out.status, title: "", not_readable: out.error };
  }
  return {
    ok: false, status: out?.status ?? null, url: parsed.href,
    error: `That link does not open: ${out?.error ?? "no answer"}.`
      + ` Do NOT send it. Say in one line that the link you had is dead and what you are doing instead — a different source, or asking them.`,
  };
}

// Does a line Reason wrote actually show the fee, rather than only a single number? This is a test
// on Reason's own composed summary, never on anything the person typed.
const SHOWS_FEE = /\bfees?\b|\ball[- ]in\b|\bincl(?:uding|usive|\.)?\b/i;
// Any money amount at all. A line with no number in it has no total to check.
const HAS_MONEY = /(?:(?:US)?\$|USD\s*)\s?\d|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars|usd)\b/i;

/**
 * They asked for the number to include fees. Does the total about to be confirmed show it?
 *
 * `fees_included` is a named key on the sheet with a meaning the rest of the code knows: present,
 * and not an explicit no, means every total Reason puts in front of them has to show the fee rather
 * than quietly being the base price. That is a flag Reason itself wrote — it is not reading of their
 * words — and the check is on the line Reason composed for the gate, which is the same line they are
 * shown. So "approved $1,850" when they asked for fees in the number is refused before they see it.
 */
export function verifyFeesShown({ sheet, total }) {
  const s = parseSheet(sheet);
  const flag = s.constraints.fees_included;
  if (!flag) return { ok: true, checked: false };
  if (/^(no|not|nope|none)\b/i.test(flag.value)) return { ok: true, checked: false, note: "the sheet says fees are not included" };
  const line = String(total ?? "");
  if (!HAS_MONEY.test(line)) return { ok: true, checked: false, note: "no total in that line to check" };
  if (SHOWS_FEE.test(line)) return { ok: true, checked: true };
  return {
    ok: false, blocked: "fees_not_shown",
    error: `They asked for the number to include fees${flag.said ? ` ("${flag.said}")` : ""}, and "${line.slice(0, 160)}" is a total with no fee line in it.`
      + ` Nothing was asked and nothing was committed. Work out the real all-in figure, say it as the base plus the fee plus the total,`
      + ` and ask again with that. If you cannot find out what the fees are, say THAT — do not show them a number you know is not the whole number.`,
  };
}

/** Phone digits, an email, or a name — compared the way each of those is actually the same thing. */
function sameParty(a, b) {
  const x = String(a ?? "").trim().toLowerCase();
  const y = String(b ?? "").trim().toLowerCase();
  if (!x || !y) return false;
  const dx = normalizeNumber(x);
  const dy = normalizeNumber(y);
  if (dx && dy) return dx === dy;
  if (x === y) return true;
  // A sheet entry is written for a person to read — "Kofi (+1 347 555 0222)", "the broker at 441
  // graham" — so a bare address or number counts as named when it appears inside one.
  return y.includes(x) || x.includes(y);
}

/**
 * The person a task is about to reach has to be somebody the job already names.
 *
 * The failure: a job collects three brokers' numbers, and a step aimed at "them" goes to the one
 * from the other errand. The sheet is the list of people this job is about, so the sheet is what a
 * send from this job is checked against — and a job that names nobody may reach nobody, which fails
 * closed rather than guessing.
 */
export function verifyRecipient({ sheet, to, task = null }) {
  const named = peopleOn(sheet);
  if (sameParty(to, "owner")) return { ok: true, who: "owner", checked: false };
  if (!named.length) {
    return {
      ok: false, blocked: "not_on_the_sheet",
      error: `${task ? `Task #${task} ` : "This job "}does not name anybody, so it cannot reach anybody.`
        + ` Put whoever this is on the sheet first — a constraint with their name or number, or a waiting entry saying who is owed what —`
        + ` and say who they are before you send. Nothing was sent.`,
    };
  }
  if (named.some(n => sameParty(to, n))) return { ok: true, who: to, checked: true, named };
  return {
    ok: false, blocked: "wrong_recipient",
    error: `'${to}' is not one of the people ${task ? `task #${task}` : "this job"} is about. On the sheet: ${named.map(n => `'${n}'`).join(", ")}.`
      + ` Nothing was sent. Either this is the wrong number — say so and ask — or they are genuinely part of this job, in which case put them on the sheet with who they are, first.`,
  };
}

/**
 * A page Reason just made, rendered and read back before its link is sent.
 *
 * Through the same `renderPage` the server uses, so what is checked is the thing they would open and
 * not a copy of it. What it catches is the page that exists as a row and comes out empty or broken —
 * which, without this, is only ever discovered by the person tapping the link.
 */
export function verifyPage(page) {
  if (!page) return { ok: false, error: "There is no page, so there is no link. Do not send one." };
  let html;
  try { html = renderPage(page, { interactive: true, forName: "" }); }
  catch (e) {
    return { ok: false, error: `That page was made but does not render (${(e?.message ?? String(e)).split("\n")[0]}), so the link would open to nothing. Do not send it; give them the answer as text instead.` };
  }
  const problems = [];
  if (!/<\/html>\s*$/i.test(String(html).trim())) problems.push("it did not come out as a whole page");
  if (!html.includes(">") || html.length < 200) problems.push("it came out empty");
  // Every block has to have put something on the page. A block that renders to nothing is a block
  // whose content silently did not make it.
  if (!(page.blocks ?? []).length) problems.push("it has no content on it");
  if (problems.length) {
    return { ok: false, error: `That page is not readable: ${problems.join("; ")}. Do not send the link; give them the answer as text instead.` };
  }
  return { ok: true, rendered: true, characters: html.length, blocks: (page.blocks ?? []).length };
}

// Links in a line Reason wrote, for checking before that line is the last word on a job. Trailing
// punctuation is stripped because a URL at the end of a sentence usually has a full stop on it.
const LINK = /\bhttps?:\/\/[^\s<>()\[\]"']+/gi;
export function linksIn(text) {
  return [...new Set((String(text ?? "").match(LINK) ?? []).map(u => u.replace(/[.,;:!?]+$/, "")))];
}

/**
 * Everything that has to be true before a job may be called **done**.
 *
 * This is the one word in Reason's vocabulary that makes somebody stop checking. Omari's line for
 * the whole feature is "can I hand it something messy, put my phone down" — and the thing that
 * makes that possible is not that Reason never fails, it is that `done` never comes back on a job
 * that was only started. So the three ways "done" is normally a lie are each a refusal here:
 *
 *   1. **It was asked about and never executed.** A job whose last step was "shall I send it?" is a
 *      job waiting on an answer. Closing it as done is the lie the person cannot catch.
 *   2. **The link does not open.** Handing over a dead link and calling the errand finished puts the
 *      work back on them, in the worst way: they find out by tapping.
 *   3. **The total is not the total.** They asked for fees in the number, and the closing line
 *      quotes the base price.
 *
 * Each refusal says what to do instead, and every one of those instructions is a real alternative —
 * `failed`, or a fixed line, never "try done again". Nothing is written while any of them stands.
 *
 * `lookup` is injectable; `gates` is passed in rather than read here so this stays testable with no
 * database. A task may always be closed `failed` or `cancelled`: honesty must never be the blocked
 * path.
 */
export async function checkFinish({ sheet, outcome, gates = [], lookup = webLookup } = {}) {
  if (gates.length) {
    const g = gates[0];
    return {
      ok: false, blocked: "asked_but_never_done",
      waiting_on: gates.map(x => ({ id: x.id, action: x.action, summary: x.summary })),
      error: `You asked them "${String(g.summary ?? "").slice(0, 200)}" and that step never went through —`
        + ` the yes is still open, so the thing it was for has not happened. That job is waiting on them, not done.`
        + ` Either they have answered since, in which case record it (confirm_record ${g.id}) and actually do the step before you close this,`
        + ` or they have not, in which case this is waiting_on_you — not done. If you mean the job ended WITHOUT that step, close it as 'failed'`
        + ` and say in the outcome that you never heard back. "Done" cannot mean "started".`,
    };
  }

  const fees = verifyFeesShown({ sheet, total: outcome });
  if (!fees.ok) {
    return { ...fees, error: `${fees.error} This is the line you would close the job on, so it is the number they will believe.` };
  }

  for (const url of linksIn(outcome)) {
    const link = await verifyLink(url, { lookup });
    if (!link.ok) {
      return {
        ok: false, blocked: "link_is_dead", url,
        error: `You are closing this with a link that does not open${link.status ? ` (${link.status})` : ""}: ${url}.`
          + ` They would find that out by tapping it. Find the one that works and close on that; if there is no working link, close as 'failed'`
          + ` or say plainly in the outcome that the link you had has gone, and what you are doing about it.`,
      };
    }
  }
  return { ok: true, links_checked: linksIn(outcome).length, fees_checked: !!fees.checked };
}
