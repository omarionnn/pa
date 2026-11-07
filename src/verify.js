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
import { renderMadePage } from "./pages/madedata.js";
import { parseSheet, peopleOn, stakesOf } from "./sheet.js";
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
 * How hard each gated action is to take back. **Code's answer, not the model's.**
 *
 * This is deliberately not a field on the ask. "Can this be undone" is exactly the question a model
 * under pressure to get a yes would answer optimistically, and it is also a question that has one
 * right answer per action, known here, forever. So the ask does not claim it — the ask names the
 * action, and this says what that means, into the result and onto what the owner is shown.
 *
 *   "no"   — nothing takes it back. A text that has landed cannot be unsent.
 *   "hard" — it can be undone, at a cost or by somebody else: a booking cancelled, a subscription
 *            resubscribed at today's price rather than the one they had.
 *   "easy" — a switch they can flip back themselves, with nothing lost.
 */
export const UNDO = {
  message_send: "no", voice_note_send: "no", call_place: "no", gmail_send: "no",
  admin_delete: "no", remote_approve: "no",
  browser_submit: "hard", subscription_cancel_commit: "hard", gmail_trash: "hard",
  account_connect: "easy", gmail_archive: "easy", gmail_mark: "easy", gmail_label: "easy",
  calendar_create: "easy", account_revoke: "easy", access_grant: "easy",
  // Taken back with permission_revoke, in one line, with nothing lost.
  permission_grant: "easy",
};

export const UNDO_SAYS = {
  no: "nothing takes this back once it has gone",
  hard: "this can be undone, but not for free and not by you alone",
  easy: "this is reversible",
};

/**
 * Does an ask actually say what is about to happen?
 *
 * The failure is the one that makes a yes worthless: "Shall I proceed?" — and the person says yes,
 * to what? A confirmation is only worth anything if the thing it authorizes is pinned down, and
 * pinning it down cannot be left to how the summary happens to be worded, because then a model that
 * writes a vague sentence gets a wide yes. So this reads the **structured** fields and nothing else:
 *
 *   - **what** — `action` has to be a real thing the gate stops. "proceed" is not an action, and a
 *     yes collected for a tool that was never gated is a person being trained to say yes to noise.
 *   - **who or where it goes** — an action that reaches somebody, or that commits on a site, has to
 *     carry its target. Without one the yes is tied to nobody and can be spent on anything; the
 *     gate would later refuse the send anyway, which means the person was asked a question that
 *     could never have authorized anything.
 *   - **the amount, when money moves** — if the ask itself says money is involved, there has to be a
 *     figure in what gets recorded and shown. "Shall I book it?" and "shall I book it, $240?" are
 *     different questions, and only the second is a yes to a number. Satisfied by an explicit
 *     `amount`, or by a figure already in the details — which is where the rest of the system
 *     reads it from (`amountForAction` and the spend cap both parse the same string).
 *   - **whether it can be undone** — supplied from `UNDO` above, so every ask carries it.
 *
 * The only thing read as text here is a line **Reason itself composed** for the gate, looked at for
 * whether a number is in it — the same thing `verifyFeesShown` does, and for the same reason.
 * Nothing a person wrote is read anywhere in this file.
 */
export function checkAsk({ action, stakes = "", target = "", amount = null, details = "", gated = true, needsTarget = false, canSpend = false }) {
  const name = String(action ?? "").trim();
  const missing = [];

  if (!gated) {
    return {
      ok: false, blocked: "not_a_gated_action",
      error: `'${name || "(nothing)"}' is not something the gate stops, so there is nothing here to approve and nothing was asked.`
        + ` A confirmation is for an action that spends money, reaches somebody who is not them, or cannot be taken back.`
        + ` If you are about to do something that really is one of those, name THAT tool in 'action'. If you just want to check a plan with them,`
        + ` ask them in a normal message — do not spend a yes on it. Being asked to approve things that need no approval is how somebody learns to say yes without reading.`,
    };
  }

  if (needsTarget && !String(target).trim()) {
    missing.push("target — who or where this lands: the exact phone number or address for anything that reaches a person,"
      + " or the same one-line 'what' you will pass to the tool for anything that commits on a site. The yes is tied to it,"
      + " so without one there is nothing the yes is a yes to");
  }

  // Both halves have to be true before an amount is demanded, and that is deliberate.
  //
  // `stakes` is a free-text field the model fills in casually — plenty of asks say "both" out of
  // caution about a text that spends nothing — so a refusal keyed on it alone would mostly fire on
  // honest asks, and the thing a model learns from being refused for being cautious is to stop
  // being cautious. So the action also has to be one that can really spend. The failure this
  // catches is the one that matters: the single tool that commits money, saying money is involved,
  // and naming no figure anywhere in what the person would be shown.
  const saysMoney = ["money", "both"].includes(String(stakes).trim().toLowerCase());
  const amountOk = Number.isFinite(amount) && amount >= 0;
  const figureInDetails = HAS_MONEY.test(String(details ?? ""));
  if (canSpend && saysMoney && !amountOk && !figureInDetails) {
    missing.push("the amount — you said this one involves money, and there is no figure anywhere in what they would be shown."
      + " Put it in the details you are recording, or pass it as `amount` in dollars. 'Shall I book it?' and 'shall I book it, $240?'"
      + " are different questions and only the second is a yes to a number. If you do not know the figure yet, go and find it:"
      + " a yes given without one is a yes to an amount nobody ever stated");
  }

  if (missing.length) {
    return {
      ok: false, blocked: "ask_says_nothing", missing,
      error: `This ask does not say what would happen, so nothing was asked and nothing was recorded. Missing: ${missing.join(" | ")}.`
        + ` Fill those in and call confirm_request again. A yes is only worth what the question said — "shall I proceed?" is a yes to nothing,`
        + ` and it is still a yes somebody gave you.`,
    };
  }

  const undo = UNDO[name] ?? "hard";
  return { ok: true, undo, undo_says: UNDO_SAYS[undo], ...(amountOk ? { amount } : {}) };
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
  // A designed page (Pages v2, src/pages/madedata.js) is checked as the page it draws as.
  try { html = renderMadePage(page, { interactive: true }) ?? renderPage(page, { interactive: true, forName: "" }); }
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
 * **How much of this runs depends on the stakes**, because a lunch suggestion does not need an
 * interview and a lease does. The mark is on the sheet, the model puts it there, and the depth is
 * code's:
 *
 *   - `low` — the open-ask check and the links, and nothing else. Being wrong about a lunch spot
 *     costs a minute, and interrogating somebody about a sandwich is its own failure.
 *   - `money` — adds the fees. This is what an unmarked job gets, so it is also exactly what every
 *     job got before the mark existed: the default tightens nothing retroactively.
 *   - `binding` — adds the two things that only matter when a mistake cannot be taken back: the
 *     real terms have to have been read and written down, and a price it closes on has to have the
 *     page it came from on the sheet. A number with no page behind it is a number nobody can check
 *     afterwards, including Reason.
 *
 * An unmarked sheet counts as `money`: the cost of over-checking a lunch spot is a wasted second
 * and the cost of under-checking a lease is a lease. So the mark that makes a job *cheaper* has to
 * be asked for, and the mark that makes it *stricter* has to be asked for; silence gets the middle.
 * Each refusal says what to do instead, and every one of those instructions is a real alternative —
 * `failed`, or a fixed line, never "try done again". Nothing is written while any of them stands.
 *
 * What comes back on a pass names `checked` and `could_not` rather than only `ok`, because "the
 * link opens and there was no total to check" and "everything was checked" are different things,
 * and the second must not be said when the first is true.
 *
 * `lookup` is injectable; `gates` is passed in rather than read here so this stays testable with no
 * database. A task may always be closed `failed` or `cancelled`: honesty must never be the blocked
 * path, at any stakes.
 */
export async function checkFinish({ sheet, outcome, gates = [], lookup = webLookup } = {}) {
  const s = parseSheet(sheet);
  const stakes = stakesOf(sheet);
  const checked = [];
  const couldNot = [];

  if (gates.length) {
    const g = gates[0];
    return {
      ok: false, blocked: "asked_but_never_done", stakes,
      waiting_on: gates.map(x => ({ id: x.id, action: x.action, summary: x.summary })),
      error: `You asked them "${String(g.summary ?? "").slice(0, 200)}" and that step never went through —`
        + ` the yes is still open, so the thing it was for has not happened. That job is waiting on them, not done.`
        + ` Either they have answered since, in which case record it (confirm_record ${g.id}) and actually do the step before you close this,`
        + ` or they have not, in which case this is waiting_on_you — not done. If you mean the job ended WITHOUT that step, close it as 'failed'`
        + ` and say in the outcome that you never heard back. "Done" cannot mean "started".`,
    };
  }
  checked.push("nothing you asked them about is still sitting unanswered");

  // Everything from here to the links is free — it reads the sheet and the line Reason composed —
  // so it runs before the fetches. A job that is going to be refused should not cost a round trip.
  if (stakes === "low") {
    couldNot.push("the fees were not checked: this job is marked low stakes");
  } else {
    const fees = verifyFeesShown({ sheet, total: outcome });
    if (!fees.ok) {
      return { ...fees, stakes, error: `${fees.error} This is the line you would close the job on, so it is the number they will believe.` };
    }
    if (fees.checked) checked.push("the closing total shows the fees they asked for");
    else if (fees.note) couldNot.push(fees.note);
  }

  // The two things that only matter when a mistake cannot be taken back.
  if (stakes === "binding") {
    // The terms. Code cannot read a lease and say it is fair; what it can do is refuse to let
    // "done" mean "I never opened it".
    if (!s.document) {
      return {
        ok: false, blocked: "terms_never_read", stakes,
        error: `This job is marked binding — hard or impossible to undo — and nothing on its sheet says the actual terms were read.`
          + ` Go and read the real document (the lease, the fare rules, the contract, the policy) and put it on the sheet with task_update:`
          + ` sheet.document with where it is as a link and what it says about the things that bite — cancellation, fees, dates — in its words, not what you expect it to say.`
          + ` If the document is genuinely not reachable, that is the finding: say so in the outcome and close as 'failed', or tell them what is unknown`
          + ` before they are the one who finds out. Do not close a binding job on a summary page about the terms.`,
      };
    }
    checked.push(`the terms were read and written down (${s.document.what}${s.document.could_not ? `; could not get at: ${s.document.could_not}` : ""})`);
    if (s.document.could_not) couldNot.push(`part of the terms could not be read: ${s.document.could_not}`);

    // And a price with nothing on the sheet saying where it came from. The failure is not a wrong
    // number, it is an unaccountable one: six weeks later nobody — not them, not Reason — can say
    // whether $1,850 was ever really the rent, so nobody can tell whether it has changed.
    if (HAS_MONEY.test(String(outcome ?? "")) && !s.prices.length) {
      return {
        ok: false, blocked: "price_with_no_source", stakes,
        error: `You are closing a binding job on a number — "${String(outcome ?? "").slice(0, 160)}" — and its sheet has no price source on it,`
          + ` so there is nothing behind that figure. This is the kind of job somebody cannot walk away from, so the number has to be checkable later.`
          + ` Put where you actually saw it on the sheet (task_update, sheet.prices, with that page as a link) and close again.`
          + ` If you cannot get the page again, do not close on the number: say in the outcome what you know and what you could not re-check, or close as 'failed'.`
          + ` A price nobody can check is a price you are asking them to take on trust.`,
      };
    }
  }
  if (s.prices.length) {
    const sites = new Set(s.prices.map(p => { try { return new URL(p.where).hostname.replace(/^www\./, ""); } catch { return p.where; } }));
    checked.push(`${s.prices.length} price(s) have a page on the sheet behind them (${[...sites].join(", ")})`);
    if (sites.size < 2) couldNot.push(`every price on this job came off one site (${[...sites][0]}), so nothing has been checked against a second one`);
  }

  const links = linksIn(outcome);
  for (const url of links) {
    const link = await verifyLink(url, { lookup });
    if (!link.ok) {
      return {
        ok: false, blocked: "link_is_dead", url, stakes,
        error: `You are closing this with a link that does not open${link.status ? ` (${link.status})` : ""}: ${url}.`
          + ` They would find that out by tapping it. Find the one that works and close on that; if there is no working link, close as 'failed'`
          + ` or say plainly in the outcome that the link you had has gone, and what you are doing about it.`,
      };
    }
  }
  if (links.length) checked.push(`${links.length} link(s) in the closing line open`);
  else couldNot.push("there was no link in the closing line to check");

  return {
    ok: true, stakes,
    links_checked: links.length,
    fees_checked: stakes !== "low" && !!verifyFeesShown({ sheet, total: outcome }).checked,
    checked,
    could_not: couldNot,
    ...(couldNot.length ? {
      note: `This passed the checks a '${stakes}' job gets. It did NOT check: ${couldNot.join("; ")}.`
        + ` Do not say you verified something in that list. If one of them matters to them, say what you do and do not know in the closing line.`,
    } : {}),
  };
}
