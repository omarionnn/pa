// Trust primitives. These are guards, and they live here so tools can call them.
// Nothing in this file asks the model to be honest; it checks the record instead.
//
// The gate in one line: a tool that spends money or acts on a third party will not run
// until the owner typed a yes, in their own words, after Reason described the action.
import * as db from "./db.js";
import * as incidents from "./incidents.js";
import { clock, config, stamp, normalizeNumber, normalizeHandle } from "./config.js";
import { sealCall } from "./privacy.js";
import { judgeReply } from "./judge.js";
import * as sites from "./sites.js";
import { spotifyStatus } from "./spotify.js";
import { googleStatus } from "./google.js";
import { githubStatus } from "./github.js";
import { uberStatus, stateOf as uberStateOf } from "./uber.js";
import { status as agentcardStatus } from "./agentcard.js";
import * as spendcap from "./spendcap.js";
import * as shop from "./shopconnect.js";

// ---------- what an explicit yes looks like ----------
// Not a word list. Which words appear in a reply says nothing about what it authorizes:
// "no problem, book it" contains "no", "don't wait, do it now" contains "don't", and
// "ok but make it 9 instead" contains "ok" while rejecting the time on record. Meaning is read
// by the judge (src/judge.js); the facts below are what code guarantees on its own.
//
// The single exception: a message that is nothing but a refusal. This is whole-message equality
// against a tiny set, never a substring search, so "no problem, book it" can never land in it.
// It is here so a flat no is honoured even when the judge is unreachable.
const BARE_REFUSALS = new Set(["no", "nope", "nah", "naw", "cancel", "stop", "don't", "dont"]);

/**
 * The tool's own name, whatever dressing the model saw it under. A model reaching these tools
 * over MCP sees them as `mcp__reason__browser_submit`, and will sometimes write that into
 * confirm_request's `action`. Left alone, the gate would then compare that string against
 * `browser_submit`, decide the yes was for a different action, and refuse a booking the owner
 * had actually approved — a guard failing closed for a reason that has nothing to do with
 * safety. One name, normalised in the one place both sides read it.
 */
export function toolName(action) {
  return String(action ?? "").replace(/^mcp__[a-z0-9_-]+__/i, "");
}

/** True only when the owner's whole message is a flat refusal and nothing else. */
export function isBareRefusal(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/[.!?…]+$/, "").trim();
  return BARE_REFUSALS.has(t);
}

/**
 * What a caller said on a call that was matched to them by caller ID alone, and never passed the
 * second check (src/calls/verify.js), is written into the thread with this tag (src/calls/postcall.js).
 * A spoofed number can say anything; those words are kept for the record but are never the owner's
 * own reply to anything (security audit 2026-11-06, leads 10-12).
 */
export const UNVERIFIED_CALL_TAG = "(on the call, caller not verified)";
const unverifiedSpeech = (content) => /^\[[^\]]*\]\s*[^:]{0,80}\(on the call, caller not verified\):/.test(content)
  // …and the line postcall.js writes to say a call happened is a note, not anything they said.
  || /^\[[^\]]*\]\s*\[on a phone call with /.test(content)
  // …and a line that says Reason wrote first and nothing came from them (events.js, eventrides.js) is
  // not from them either: an event's name, which somebody else chose, is in it.
  || /^\[[^\]]*\]\s*\(nothing from them\b/.test(content);

/** The owner's own messages in this conversation, oldest first, with the timestamp prefix stripped. */
export function ownerTexts(messages = []) {
  return messages
    .filter(m => m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[event ") && !unverifiedSpeech(m.content))
    .map(m => m.content.replace(/^\[[^\]]*\]\s*/, "").replace(/^[^:]{0,40}:\s*/, "").trim());
}

const sayNorm = (t) => String(t ?? "").toLowerCase().normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/[^\p{L}\p{N}$%.'\s]/gu, " ").replace(/\s+/g, " ").trim();
const LITTLE = new Set(["the", "and", "you", "can", "for", "with", "that", "this", "your", "my", "me", "to", "of", "a", "an", "it", "on", "in", "at", "up", "any", "just", "from", "now"]);
const contentWords = (t) => sayNorm(t).split(" ").map(w => w.replace(/^[$.']+|[.']+$/g, "")).filter(w => w.length >= 3 && !LITTLE.has(w));

/**
 * Only what they typed: a stored message of theirs also carries Reason's own notes on later lines in
 * [brackets] (the text of a PDF they sent, the message an inline reply was under, which card a number
 * picks), and none of that is their saying anything.
 */
export function typedOnly(t) {
  // Notes come in two places: one-line ones in front of what they typed (the message an inline reply is
  // under, which card a number picks) and the rest after it (a PDF's whole text, what a photo was). So:
  // the one-line notes in front are skipped, and from the first note after their words on, nothing is
  // theirs. A note's own text can hold a "]" (a document says anything), so its end is never trusted.
  const lines = String(t).split("\n");
  let i = 0;
  while (i < lines.length && /^\s*\[[^\n]*\]\s*$/.test(lines[i])) i++;
  const out = [];
  for (; i < lines.length; i++) { if (/^\s*\[/.test(lines[i])) break; out.push(lines[i]); }
  return out.join("\n").trim();
}
const typed = (messages, last) => ownerTexts(messages).slice(-last).map(typedOnly).filter(Boolean);


/**
 * Did the owner really say this? `said` must appear, give or take case, spacing and punctuation, in
 * one of their own recent messages (`ownerTexts`, so never a tool result, an event or an unverified
 * call). For a change to the gate itself (a standing permission, spending limits), whose words are
 * the whole of the authority: the model's paraphrase of what they wanted is not their saying it.
 */
export function ownerSaidWhere(messages, said, { last = 12 } = {}) {
  const want = sayNorm(said);
  const words = contentWords(said);
  // A sentence that grants something says what: "ok" or "thanks" quoted back is not a permission.
  if (words.length < 3) return null;
  return typed(messages, last).reverse().find(t => {
    const theirs = sayNorm(t);
    if (theirs.includes(want)) return true;
    // A light retelling of one message of theirs (the model tidied the wording): nearly every word that
    // carries meaning is theirs. A sentence they never sent shares almost none.
    const have = new Set(contentWords(t));
    return words.filter(w => have.has(w)).length / words.length >= 0.8;
  });
}

/**
 * True when `said` is in one of their recent typed messages (see ownerSaidWhere). Finding the words is
 * not knowing what they meant: "never text my mom without asking" holds "text my mom without asking".
 * A caller that grants something on the strength of it has the message read for meaning as well.
 */
export function ownerSaid(messages, said, opts) { return ownerSaidWhere(messages, said, opts) != null; }

/** Did one recent message of theirs name every one of these dollar amounts? ("$1,500", "1500", "1500.00") */
export function ownerSaidAmounts(messages, amounts, { last = 12 } = {}) {
  const nums = (t) => new Set((String(t ?? "").replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
  return typed(messages, last).some(t => { const have = nums(t); return amounts.every(a => have.has(Number(a))); });
}

/**
 * In the shared thread, an ask still open in an earlier Web-only chat moves here, counted from these
 * `messages` (src/db.js adoptWebChatAsks): one thread only, owner 10-27 07:08.
 */
export function adoptWebChatAsks(conversationId, messages) {
  try { return db.adoptWebChatAsks(conversationId, ownerTexts(messages).length); } catch { return 0; }
}

/**
 * Step 1 of the gate. Records what Reason is about to do, in words, before asking.
 * Returns the confirmation id the model must carry into the committing tool.
 */
export function requestConfirmation({ conversationId, messages, action, summary, stakes, target = "", taskId = null, amount = null, historyId = null }) {
  const c = db.askConfirmation({
    amount,
    // The thread `messages` is: a Web-only chat's own, or the shared one (src/db.js historyKeyFor).
    threadKey: historyId,
    conversationId, action: toolName(action), summary, stakes, target: normalizeTarget(target),
    askedAfterMsgs: ownerTexts(messages).length,
    // Which job this ask belongs to, when there is one. It is what lets a task refuse to close as
    // done while one of its own gated steps is still waiting on an answer. See unexecutedGatesFor.
    taskId,
  });
  return {
    ok: true,
    confirmation_id: c.id,
    state: "waiting_for_yes",
    recorded: summary,
    ...(c.target ? { target: c.target } : {}),
    next: `Now say that back to them in your own words and wait. When they reply, call confirm_record with confirmation_id ${c.id}. Do not call ${action} until confirm_record returns state 'granted'.`,
  };
}

// What a phone number can be made of and nothing else: digits, and the punctuation people write
// them with. The test is on the WHOLE string, which is the point — see normalizeTarget.
const PHONE_ONLY = /^[+()\-.\s\d]+$/;

/**
 * A phone number is compared as digits; anything else is compared as its own trimmed text.
 * This is the one place a target is made comparable, so the gate and the tool cannot disagree
 * about whether "+1 (212) 555-9999" and "+12125559999" are the same place.
 *
 * "Is this a phone number" is asked of the whole string rather than of how many digits are in it
 * somewhere. It used to be "seven digits anywhere", which quietly wrecked every target that was not
 * a number: a booking target of "Carbone, Fri Sep 26 2026, 8pm, party of 4, $240" became
 * "+262026800 4240" — every word thrown away — and an email target became its own punctuation
 * removed. Two genuinely different actions could then normalise to the same string and a yes for one
 * would authorize the other, which is the exact failure the target exists to prevent.
 */
export function normalizeTarget(t) {
  const s = String(t ?? "").trim();
  if (!s) return "";
  if (!PHONE_ONLY.test(s)) return s.toLowerCase();
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 ? `+${digits}` : s.toLowerCase();
}

/**
 * The tools whose yes is pinned to a person AND to what reaches them (audit lead 26, 11-07). A yes to
 * "text Kofi: running late" used to be pinned to Kofi's number only, so the same yes could carry any
 * words to Kofi — or any call brief — for as long as it lasted. Now the target is "<who>: <what>",
 * built by personPin from the input the tool really got, the same way gmail_send and x_dm pin theirs.
 */
export const PERSON_PINNED = new Set(["message_send", "voice_note_send", "call_place"]);

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * "<number>: <what reaches them>" for a text, a voice note or a call. For a call that is the goal and
 * the facts it may give out (read as one run of words, so src/tools.js fitCallBrief moving a long goal
 * into facts does not change it), plus anything it may agree to or hand over: may_book and its
 * ceiling, the approved terms, the requirements, and the questions it asks out loud (ask).
 * read_back (fixed choices) and max_minutes only shape how it asks.
 */
export function personPin(name, input = {}) {
  const who = normalizeHandle(input.to) || String(input.to ?? "").trim();
  if (name === "message_send") return `${who}: ${oneLine(input.text)}`;
  if (name === "voice_note_send") return `${who}: voice note ${oneLine(input.file)}${oneLine(input.text) ? ` with "${oneLine(input.text)}"` : ""}`;
  const parts = [oneLine([input.goal, ...(Array.isArray(input.facts) ? input.facts : [])].join(" "))];
  const asks = Array.isArray(input.ask) ? input.ask.map(oneLine).filter(Boolean) : [];
  if (asks.length) parts.push(`asks: ${asks.join("; ")}`);
  if (input.may_book === true) parts.push("may book");
  if (input.max_price_cents != null) parts.push(`up to ${money(Number(input.max_price_cents))}`);
  if (Array.isArray(input.approved_terms) && input.approved_terms.length) parts.push(`terms: ${input.approved_terms.map(oneLine).join("; ")}`);
  const req = input.requirements && typeof input.requirements === "object" ? Object.entries(input.requirements) : [];
  if (req.length) parts.push(`gives: ${req.map(([k, v]) => `${oneLine(k)} ${oneLine(v)}`).join("; ")}`);
  return `${who}: ${parts.join(" | ")}`;
}

/** The person half of a target ("+1555…: words" → "+1555…"); a target with no words is itself. */
export function personOfTarget(t) {
  const s = String(t ?? "").trim();
  const i = s.indexOf(": ");
  return i > 0 ? s.slice(0, i).trim() : s;
}

/**
 * Asks that ran out since the model last looked, for the turn the person starts: shown once, then
 * stamped (expiry_told_at), so it can let them know in a line if it still matters and otherwise say
 * nothing. Never a reason to send anything on its own: this is only ever read on a turn they started.
 * "" when there is nothing to show.
 */
export function expiredAsksNote(conversationId) {
  let rows;
  try { rows = db.expiredUntold(conversationId); } catch { return ""; }
  const claimed = new Set(db.markExpiryTold(rows.map(r => r.id)));
  const lines = rows.filter(r => claimed.has(r.id)).map(r => r.granted_at
    ? `  - they said yes but it was never done, and that yes has run out (${r.action}, asked ${stamp(r.asked_at)}): ${r.summary}`
    : `  - ran out without an answer (${r.action}, asked ${stamp(r.asked_at)}): ${r.summary}`);
  if (!lines.length) return "";
  return `Asks of yours that ran out and are now closed as a no:\n${lines.join("\n")}\n`
    + `Only if one still matters, mention it in at most one short line (for example, that you let that order go since you did not hear back); otherwise say nothing about it. Never do any of these: they are closed, and doing one needs fresh details and a fresh confirm_request.`;
}

/** What the model is told when it reaches for an ask that ran out. Describes what to do, never words to say. */
function expiredError(c, why) {
  const what = why === "yes_unused"
    ? `The yes on confirmation #${c.id} (${c.action}) was given ${Math.round((clock.now() - c.granted_at) / 60_000)} minutes ago and never used, and a yes only counts for ${config.confirmWindowMin}`
    : `Confirmation #${c.id} (${c.action}) was asked ${stamp(c.asked_at)} and ran out before it was answered`;
  return `${what}, so it is closed as a no. Do not act on this yes. If they still want it, re-check the current details first (fresh price, availability or time, with the normal tool), then call confirm_request fresh with what is true now, and ask them once.`;
}

/**
 * Step 2 of the gate. The guard, not the model, decides. Code checks the facts: the reply must be
 * a real NEW owner message that arrived after the ask, and the confirmation must still be open.
 * The judge then reads what that reply means against the summary that was recorded.
 *
 * `judge` is injectable so tests can state what a reply means and exercise the bookkeeping.
 */
export async function recordConfirmation({ conversationId, messages, confirmationId, judge = judgeReply, historyId = null }) {
  if (!historyId || historyId === conversationId) adoptWebChatAsks(conversationId, messages);
  const c = db.getConfirmation(conversationId, confirmationId);
  if (!c) return { ok: false, error: `No confirmation #${confirmationId} in this conversation.` };
  // Asked in one thread (the shared one, or a Web-only chat), answered only there: the count below is
  // that thread's, and a "yes" said somewhere else was never said to this ask.
  const here = historyId && historyId !== conversationId ? String(historyId) : null;
  if (!c.consumed_at && !c.refused_at && !c.granted_at && (c.thread_key ?? null) !== here) {
    return {
      ok: false, state: "asked_elsewhere",
      error: `Confirmation #${confirmationId} was asked in ${c.thread_key ? "another Web chat" : "their main thread"}, not this one, so nothing here answers it. If they want it now, ask again here with confirm_request and wait for their reply.`,
    };
  }
  if (c.consumed_at) return { ok: false, state: "spent", error: `Confirmation #${confirmationId} was already used for ${c.action}. Ask again.` };
  if (c.refused_at) return { ok: false, state: "refused", error: `Confirmation #${confirmationId} was refused. Do not retry unless they bring it up.` };
  // An ask that ran out is a no, whatever they say now. A late yes is not a yes to what is on record:
  // the price, the stock, the moment the call was for have all had time to move.
  const overdue = db.askOverdue(c);
  if (overdue) {
    db.expireConfirmation(c.id);
    return { ok: false, state: "expired", confirmation_id: c.id, action: c.action, error: expiredError(c, overdue) };
  }
  if (c.granted_at) return { ok: true, state: "granted", confirmation_id: c.id, action: c.action, quote: c.granted_quote };

  const texts = ownerTexts(messages);
  if (texts.length <= c.asked_after_msgs) {
    return {
      ok: false, state: "waiting_for_yes",
      error: `They have not answered yet. You asked and they have not replied since. Wait for their next message; do not confirm on their behalf.`,
    };
  }
  const latest = texts.at(-1);
  // One reply is a yes to one ask. Two asks opened in the same turn share one mark, so without this the
  // "yes" they meant for the one they were shown would grant the other as well, including one they were
  // never told about (security audit 2026-11-06, lead 27).
  const used = db.grantedByReply(c, texts.length);
  if (used) return replyUsed(c, used);

  // A flat no needs no reading, and is honoured even if the judge is down.
  if (isBareRefusal(latest)) {
    db.refuseConfirmation(c.id);
    return { ok: false, state: "refused", quote: latest, error: `That reads as a no. ${c.action} is off. Say so and move on.` };
  }

  const { verdict, note, error } = await judge({ summary: c.summary, reply: latest });

  if (verdict === "no") {
    db.refuseConfirmation(c.id);
    return { ok: false, state: "refused", quote: latest, error: `That reads as a no. ${c.action} is off. Say so and move on.` };
  }
  // They want it, but not as described. Nothing is authorized and nothing is refused: the details
  // on record are not the details they agreed to, and a yes only ever covers what was described.
  if (verdict === "change") {
    return {
      ok: false, state: "changed", quote: latest, wants: note ?? "",
      error: `They said yes to something different${note ? `: ${note}` : ""}. Nothing is authorized, because what is on record is not what they want. Change the details first, then call confirm_request again with the new summary and ask once more.`,
    };
  }
  if (verdict !== "yes") {
    return {
      ok: false, state: "waiting_for_yes", quote: latest,
      error: error
        ? `Their reply could not be read (${error}), so nothing is authorized. Ask once, plainly, for a yes.`
        : `Their reply does not read as a clear yes or no, so nothing is authorized. Ask once, plainly, for a yes.`,
    };
  }
  if (!db.grantConfirmationByReply(c.id, latest, texts.length)) {
    const fresh = db.getConfirmation(conversationId, c.id);
    if (fresh?.granted_at) return { ok: true, state: "granted", confirmation_id: c.id, action: c.action, quote: fresh.granted_quote };
    return replyUsed(c, db.grantedByReply(c, texts.length));
  }
  return { ok: true, state: "granted", confirmation_id: c.id, action: c.action, quote: latest };
}

/** Their latest reply already said yes to another ask: nothing about this one is decided. */
function replyUsed(c, used) {
  return {
    ok: false, state: "waiting_for_yes",
    error: `Their last reply was already taken as the yes to confirmation #${used?.id ?? "?"}${used ? ` (${used.action})` : ""}. One reply is a yes to one thing, so nothing is authorized for #${c.id} (${c.action}). If they want this too, say this one to them on its own and wait for their next reply.`,
  };
}

/**
 * The guard a committing tool passes through. Returns { ok: true, confirmation } or a refusal
 * the tool must return verbatim. It does NOT spend the yes — see spendConfirmation.
 *
 * Checking and spending are separate on purpose. A yes buys exactly one real action, but a tool
 * that fails before touching anything (a stale element ref, an unreachable page) has used nothing
 * up, and burning the yes there would leave the owner having said go with nothing done and no way
 * to retry but to be asked again. So the yes is spent at the moment the action is really attempted.
 */
export function authorizeConfirmation({ conversationId, action, confirmationId, target = null }) {
  if (!confirmationId) {
    return { ok: false, blocked: "needs_confirmation", error: `${action} spends money or acts on someone else, so it needs an explicit yes first. Call confirm_request, tell them exactly what you are about to do, wait for their answer, then confirm_record, then call ${action} again with that confirmation_id.` };
  }
  const c = db.getConfirmation(conversationId, confirmationId);
  if (!c) return { ok: false, blocked: "no_such_confirmation", error: `No confirmation #${confirmationId} in this conversation.` };
  const want = toolName(action);
  if (toolName(c.action) !== want) return { ok: false, blocked: "wrong_action", error: `Confirmation #${confirmationId} was for ${c.action}, not ${want}. A yes covers one action only.` };
  if (c.consumed_at) return { ok: false, blocked: "already_spent", error: `Confirmation #${confirmationId} was already used. Ask again before doing this twice.` };
  if (c.refused_at) return { ok: false, blocked: "refused", error: `Confirmation #${confirmationId} was refused.` };
  // Defence in depth: recordConfirmation already refuses to grant an ask that ran out, and this
  // refuses to act on one whatever the row says.
  if (!c.granted_at && db.askOverdue(c)) {
    db.expireConfirmation(c.id);
    return { ok: false, blocked: "expired", error: expiredError(c, "unanswered") };
  }
  if (!c.granted_at) return { ok: false, blocked: "not_granted", error: `Confirmation #${confirmationId} has no yes on it yet. Wait for their reply and call confirm_record.` };
  // For anything aimed at a person — a text, a call — the yes covers that person and nobody
  // else. The owner agreed to a number they were shown; dialling a different one on the same
  // yes is the mistake worth being unable to make, so it is checked here rather than trusted.
  if (target !== null) {
    const want = normalizeTarget(target);
    if (!c.target) {
      // The wording depends on what the yes was meant to cover: a person for a text or a call,
      // the exact details for a submit. A message about phone numbers is no help to a booking.
      const what = action === "browser_submit"
        ? `does not say what ${action} was for, so it cannot authorize committing anything. Call confirm_request again with target set to the same one-line details you will submit, show them those details, and ask again.`
        : PERSON_PINNED.has(toolName(action))
          ? `does not say who ${action} was for or what it says, so it cannot authorize reaching anyone. Call confirm_request again with target set to the use_target string this refusal hands back, show them that person and those exact words, and ask again.`
          : toolName(action) === "account_connect"
            ? `does not say which account ${action} was for, so it cannot connect anything. Call confirm_request again with target set to the use_target string this refusal hands back, name that provider to them, and ask again.`
            : `does not say who ${action} was for, so it cannot authorize reaching anyone. Call confirm_request again with target set to the exact number, show them that number, and ask again.`;
      return { ok: false, blocked: "no_target_on_record", error: `Confirmation #${confirmationId} ${what}` };
    }
    if (c.target !== want) {
      const what = action === "browser_submit"
        ? `A yes covers the exact details they were shown, and these are not them. Say what has changed, then confirm_request again with the new details and ask.`
        : PERSON_PINNED.has(toolName(action))
          ? `A yes covers the one person and the exact words they were shown, and this is not both of them. Send exactly what they agreed to, or confirm_request again with target set to use_target and ask about this one.`
          : toolName(action) === "account_connect"
            ? `A yes covers connecting the one account they were told about. Ask again for this one.`
            : `A yes covers the one person they were shown. Ask again for this one.`;
      return { ok: false, blocked: "wrong_target", error: `Confirmation #${confirmationId} was for '${c.target}', not '${want}'. ${what}` };
    }
  }
  const ageMin = (clock.now() - c.granted_at) / 60_000;
  if (c.expired_at || ageMin > config.confirmWindowMin) {
    db.expireConfirmation(c.id);
    return { ok: false, blocked: "stale", error: `That yes was ${Math.round(ageMin)} minutes ago and only counts for ${config.confirmWindowMin}. Ask again before doing it.` };
  }
  return { ok: true, confirmation: { id: c.id, quote: c.granted_quote, granted: stamp(c.granted_at), summary: c.summary } };
}

/**
 * Spends the yes: from here on it authorizes nothing else. Called once the action is actually
 * being attempted, never before. Idempotent, so a caller cannot double-spend by asking twice.
 */
export function spendConfirmation(conversationId, confirmationId) {
  const c = db.getConfirmation(conversationId, confirmationId);
  if (!c || c.consumed_at) return false;
  db.consumeConfirmation(c.id);
  return true;
}

// ---------- connected accounts ----------
// Each provider says what credentials it needs. Nothing here fakes a connection:
// if the credentials are absent the status is not_connected and stays that way.
/**
 * Everything Reason could be given access to, and whether it has been.
 *
 * Two fields decide what a provider reports, and they are different questions:
 *
 *   `needs`  — the credentials this machine must have, by name. Missing any ⇒ not_connected.
 *   `built`  — whether Reason has any code for it at all. `false` ⇒ not_connected whatever the
 *              environment holds, because credentials for an integration nobody wrote do not make
 *              it work. These exist in the registry so `capabilities` and `account_list` can
 *              answer honestly today about apps Omari has chosen but nothing has been built for.
 *
 * `via` says how it would be reached: an official API, or the browser signed in as the owner would
 * sign in. The browser ones all wait on saved logins, which is itself not built.
 *
 * Nothing unbuilt names an environment variable it has not got. Inventing `SPOTIFY_CLIENT_ID`
 * here would be making up an integration's shape before anyone has read its docs, and the
 * capabilities tool would then repeat that invention as fact.
 */
export const PROVIDERS = {
  browser: {
    needs: [],
    built: true,
    via: "browser",
    scopes: ["browse", "fill_forms", "keep_logins"],
    what: "a real Chromium Reason drives itself, one profile per conversation, logins kept between turns",
  },
  // Gmail and Calendar, built now from Google's current docs. Both want the same two credentials and
  // neither wants a refresh token in the environment, which is the change worth being exact about:
  // these entries used to need one GOOGLE_OAUTH_REFRESH_TOKEN for the owner, from before every
  // person had their own Reason. One refresh token in .env would mean every person who texted
  // reached the SAME inbox — not a configuration problem but the wrong inbox. So the client id and
  // secret are the machine's, and the refresh token is per conversation in `oauth_tokens`: the
  // person's own half, given on Google's own consent screen. See src/google.js.
  //
  // `oauth: "google"` is what tells accountStatus to read the tokens table for this conversation
  // rather than stopping at "the credentials exist". One grant covers both of these, so they connect
  // together — and a consent screen with one box unticked leaves the other honestly not connected.
  gmail: {
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    built: true,
    via: "api",
    oauth: "google",
    scopes: ["read_mail", "send_mail", "label_mail"],
    what: "read, search and send this person's email, read a PDF or text file attached to one, draft and reply inside a thread, label, archive and bin it",
    supply: "a Web application OAuth client from the Google Cloud console with Reason's callback address in its redirect URIs, and then this person tapping the connect link once",
  },
  google_calendar: {
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    built: true,
    via: "api",
    oauth: "google",
    scopes: ["read_events", "write_events"],
    what: "read this person's calendar and put events on it",
    supply: "a Web application OAuth client from the Google Cloud console with Reason's callback address in its redirect URIs, and then this person tapping the connect link once",
  },
  // Drive, built 2026-10-06 from Google's current docs. Same client and the same two credentials as
  // the other two, and `oauth: "google"` for the same reason — connected is read off this person's
  // own token row, never off the credentials existing.
  //
  // What is different from Gmail and Calendar, and why it matters here: **Drive is not part of a
  // plain "connect my Google"**. Its two scopes are asked for when a Drive tool wants them (Google's
  // own advice — see DEFAULT_SCOPES in src/google.js), so somebody who connected mail last week has
  // a live Google grant and no Drive, and this entry reports exactly that rather than inheriting
  // Gmail's status. `covers()` is what decides it, so there is no second rule to keep in step.
  google_drive: {
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    built: true,
    via: "api",
    oauth: "google",
    // `organise_files` is only ever on a row where drive.file was really granted (drive.metadata
    // before 2026-11-11, which old grants still carry). See CONNECTS in
    // src/google.js: it is an extra on the same connection, not a connection of its own.
    scopes: ["read_files", "write_files", "organise_files"],
    what: "find a file Reason made (or they opened with Reason) in this person's Drive and read it — documents, spreadsheets, slides, text files, and a PDF with text in it, read on this machine — hand one of their own files back in the thread as a PDF or a Word document, make a new Google Doc or folder, put a file Reason wrote in there, and organise what is already in it: rename, move into folders, put in the bin. A PDF that is a scan has no text to read and says so. Never deletes anything of theirs for good, never makes anything public, and can only share a file with another person where Reason itself made that file",
    supply: "a Web application OAuth client from the Google Cloud console with Reason's callback address in its redirect URIs and drive.file on its Data Access page, and then this person tapping the Google connect link once",
  },
  // Built now, from Spotify's current docs. The credentials are a developer app's client id and
  // secret; the *person's* half is an authorization they give on Spotify's own page, which is why
  // being `connectable` here is not being connected — see src/spotify.js.
  spotify: {
    needs: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
    built: true,
    via: "api",
    scopes: ["search", "read_playback", "control_playback", "make_playlists", "read_history"],
    what: "search Spotify, see and control what is playing, make playlists, and read listening history",
    supply: "a Spotify developer app from developer.spotify.com/dashboard, with Reason's callback address added to its Redirect URIs, and then the owner tapping the authorize link once",
  },
  // GitHub, built from their current docs. The credentials are an OAuth App's client id and secret;
  // the person's half is an authorization they give on GitHub's own page. Tokens do not expire, so
  // there is no refresh dance — a dead token means they revoked it and a new authorize is the fix.
  github: {
    needs: ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"],
    built: true,
    via: "api",
    oauth: "github",
    scopes: ["read_repos", "write_issues", "read_pulls", "merge_pulls", "search_code"],
    what: "list repos, read code, search across repos, create and comment on issues, list and merge pull requests, and check notifications",
    supply: "a GitHub OAuth App from github.com/settings/developers, with Reason's callback address as its Authorization callback URL, and then this person tapping the authorize link once",
  },
  // Uber's official Riders API, built 2026-10-15 from their current docs. The credentials are an
  // Uber app's client id and secret; the person's half is a sign-in and a consent they give on
  // Uber's OWN page, on their own phone — which is the entire reason this exists. Reason's other
  // way into Uber, signing in inside its own headless browser, is answered from the server by a
  // Cloudflare bot check.
  //
  // **Why the key is `uber_api` and not `uber`.** `uber` is already in this registry as a browser
  // site, from the spread at the end of this object — and a spread at the end wins the key. Naming
  // this one `uber` would therefore either do nothing or, moved below the spread, silently delete
  // the site entry that `signin_*`, `account_revoke` and the `uber_link` handoff all read. They are
  // genuinely two different connections with two different credentials and two different things
  // they can do, so they get two rows, the same way `spotify` is an API account in here rather than
  // a site. `account_list` shows both and says what each one can really do.
  //
  // The scope list is where the honesty lives. `request` and `request_receipt` are privileged by
  // Uber's own classification, which under their default Limited Access means they work for the
  // owner's own Uber account and for the developer accounts listed in the app dashboard, and for
  // nobody else. So "connected" and "can book a ride" are two different states here, and
  // src/uber.js reports them as two different states.
  uber_api: {
    needs: ["UBER_CLIENT_ID", "UBER_CLIENT_SECRET"],
    built: true,
    via: "api",
    oauth: "uber",
    scopes: ["identity", "saved_places", "quote_ride", "request_ride", "cancel_ride", "ride_receipt"],
    what: "quote a real Uber with its upfront fare, request the one ride they said yes to, follow the driver, and cancel it —"
      + " on Uber's official Riders API, with the person signed in on their own phone and Reason never seeing a password",
    supply: "an Uber app from developer.uber.com/dashboard/create with Reason's callback address added as a Redirect URI exactly as written"
      + " and the five scopes ticked on its Auth tab (profile, places, offline_access, request, request_receipt), and then this person signing in"
      + " through the connect link once. For the ride itself there is one more condition and it is Uber's: `request` is a privileged scope, so under"
      + " Uber's default Limited Access it only works for the owner's own Uber account and for the developer accounts listed in that dashboard."
      + " Anybody else needs Uber to grant the app Full Access, which they only review for a complete app with a published public privacy policy",
  },
  phone_out: {
    needs: ["REASON_TELEPHONY_KEY", "REASON_PHONE_NUMBER"],
    built: true,
    via: "api",
    scopes: ["call_places", "call_owner"],
    what: "place a phone call, hold, and report back, with the recording",
    supply: "an account with a call provider that records every call (see docs/call-providers.md), and a number",
  },
  // AgentCard, built from their current docs. Two credentials, both this machine's: the person's own
  // half is a card they type on AgentCard's page and lock with a passkey, which is why `connected`
  // here is not the same as "this person can buy something" — that is their vault, read per
  // conversation by the purchase tools.
  agentcard: {
    needs: ["AGENTCARD_CLIENT_ID", "AGENTCARD_CLIENT_SECRET"],
    built: true,
    via: "api",
    scopes: ["store_card", "buy", "track_orders"],
    what: "buy things from real shops with a card the person keeps in AgentCard's vault — Reason shows the exact cart and total,"
      + " they say yes, and then they approve the payment again on their own phone with a passkey",
    supply: "an AgentCard organization from app.agentcard.sh with its client id and secret in .env, and then this person tapping the vault link once to store a card",
  },
  payments: {
    needs: ["REASON_PAYMENTS_KEY"],
    built: true,
    via: "api",
    scopes: ["pay_link", "refund"],
    what: "send a pay link, split a bill, refund",
    supply: "an account with a payments provider",
  },
  // Sites Omari chose, reached the way he would reach them: in a browser, signed in as himself.
  //
  // These are built now — saved sign-ins exist (src/signin.js) and each site has a playbook
  // (src/sites.js). What `built: true` means here is narrow and worth being exact about: the
  // plumbing is written and tested. It does NOT mean the site cooperates. Most of these refuse an
  // automated browser outright, and `siteNotes` below carries that per site so a status nobody can
  // use never reads as a status that works.
  //
  // `needs: []` because the credential is not an environment variable. It is a browser profile
  // with the site's own cookies in it, which only exists after the person signs in themselves, so
  // whether this is connected is read off the last sign-in probe rather than off process.env.
  ...Object.fromEntries(sites.SITES.map(s => [s.site, {
    needs: [],
    built: true,
    via: "browser",
    scopes: ["browse", "fill_forms", "keep_logins"],
    what: s.what,
    supply: `the owner signing in once themselves in Reason's own browser: npm run signin -- ${s.site}`,
  }])),
};

/**
 * Whether a site will even talk to this browser, from the probe run in `docs/site-probe-*.json`.
 *
 * Kept next to the registry rather than inside it because it is a finding with a date on it, not a
 * property of the site: a site that refuses today may not next month, and whoever re-runs
 * `npm run probe:sites` should be changing one list and not hunting through two.
 */
export const SITE_REACHABLE = {
  opentable: { seen: "2026-11-12", loads: false, why: "drops the connection on an automated browser (ERR_HTTP2_PROTOCOL_ERROR), and answers plain curl with 403" },
  uber: { seen: "2026-10-05", loads: true, why: "m.uber.com loads; the ride form is visible signed out, prices and cars are not" },
  // `seen` is the day of the probe run the line comes from. OpenTable, DoorDash, Uber Eats and
  // Ticketmaster were probed again 2026-11-12 (docs/site-probe-2026-11-12-signin.json); whether a
  // SIGN-IN may be offered is src/sitefindings.js, which expires and re-asks.
  // Probed again 2026-11-12 (docs/site-probe-2026-11-12-food.json): Cloudflare's check, never clearing,
  // in the same headless browser from a home connection too. It is the automated browser, not the server's address.
  doordash: { seen: "2026-11-12", loads: false, why: "answers 403 on every page" },
  uber_eats: { seen: "2026-11-12", loads: false, why: "its sign-in page answers 403; only the signed-out home page loads" },
  amazon: { seen: "2026-10-05", loads: true, why: "loads, and the order-history page redirects to Amazon's sign-in exactly as the probe expects" },
  delta: { seen: "2026-10-05", loads: false, why: "answers Access Denied (HTTP 444) on every page" },
  united: { seen: "2026-10-05", loads: false, why: "drops the connection on an automated browser and on plain curl too" },
  ticketmaster: { seen: "2026-11-12", loads: false, why: "answers 403 on every page" },
  fandango: { seen: "2026-10-05", loads: true, why: "loads, and the account page redirects to Fandango's sign-in exactly as the probe expects" },
};

export function missingCredentials(name) {
  const p = PROVIDERS[name];
  if (!p) return null;
  // Spotify is asked rather than inferred from process.env. Its module reads the two values
  // through `config`, which is also where a test or a deployment can set them, so reading the
  // environment directly here would let this registry say "not connected" about an integration
  // that works — the exact kind of quiet disagreement between two sources this file exists to stop.
  if (name === "spotify") return spotifyStatus().missing;
  // GitHub, same reason: src/github.js reads the client id and secret through `config`.
  if (name === "github") return githubStatus().missing;
  // Uber's API, same reason again: src/uber.js reads the client id and secret through `config`, so
  // asking process.env here would let this registry call a working integration "not connected".
  if (name === "uber_api") return uberStatus().missing;
  // AgentCard, same reason: src/agentcard.js reads the client id and secret through `config`, so
  // asking the environment here would let this registry call an integration that works "not
  // connected" — and the module's own status is the one the purchase tools refuse from.
  if (name === "agentcard") return agentcardStatus().missing;
  // Gmail and Calendar, for the same reason: src/google.js reads the client id and secret through
  // `config`, so asking the environment here would let this registry call an integration that works
  // "not connected". Drive is deliberately not in here — nothing is built for it, and `needs` is the
  // honest answer about an entry whose status comes off `built: false` anyway.
  if (p.oauth === "google") return googleStatus().missing;
  return p.needs.filter(k => !process.env[k]);
}

/**
 * Whether this person's Uber grant can actually request a ride, in the words a status should use.
 *
 * Its own little function because the answer is a sentence and not a boolean: an identity-only Uber
 * is a real connection that books nothing, and "connected" on its own would be read as "can book".
 */
function uberRideAccess(conversationId) {
  const st = uberStateOf(conversationId);
  if (st.state === "ride_access") return { ride_access: "ready", can_book: true };
  if (st.state === "connected") return { ride_access: "identity_only", can_book: false, ride_access_why: st.why };
  return {};
}

/** The Crossmint-connected store row for this site (src/shopconnect.js), or null. Removed stores are not listed. */
export function storeConnected(conversationId, name) {
  try { return shop.connectedStores(conversationId).find((s) => s.store === name) ?? null; } catch { return null; }
}

export function accountStatus(conversationId, name) {
  const p = PROVIDERS[name];
  if (!p) return { name, status: "unknown_provider" };
  const missing = missingCredentials(name);
  const row = db.liveAccount(conversationId, name);

  // A site reached through the browser is a different question from a site reached with a key.
  // There is no credential in the environment to check: it is connected when the SITE last agreed
  // it was signed in, and not when anybody wanted it to be. So this branch reads the last probe,
  // reports when that was, and carries whether the site even answers an automated browser — a
  // "connected" that cannot load a page is a status that would get somebody promised an errand
  // nothing can do.
  if (p.via === "browser" && sites.site(name)) {
    const last = db.lastSigninCheck(conversationId, name);
    const reach = SITE_REACHABLE[name] ?? null;
    const entry = sites.site(name);
    const common = {
      name, what: p.what, via: "browser", scopes_available: p.scopes,
      needs_signin: entry.needs_signin,
      site_loads_for_reason: reach?.loads ?? null,
      ...(reach ? { site_note: reach.why } : {}),
      ...(entry.ride_access ? { ride_access: entry.ride_access } : {}),
      ...(last?.checked_at ? { last_checked: stamp(last.checked_at) } : {}),
      ...(last?.evidence ? { evidence: last.evidence } : {}),
    };
    if (row && row.state === "signed_in") {
      return { ...common, status: "connected", scopes: JSON.parse(row.scopes), connected_at: stamp(row.connected_at), revoked_at: null };
    }
    // A store connected through Crossmint (shop_stores) is connected even though Reason's own browser
    // never signed in to it. Same source src/connectafter.js connectedAt() reads, so this and the
    // connect-the-rest page can never disagree. A removed store has status 'removed' and is not here.
    const viaStore = storeConnected(conversationId, name);
    if (viaStore) {
      return {
        ...common, status: "connected", via: "crossmint", scopes: common.scopes_available,
        connected_at: stamp(viaStore.connectedAt), revoked_at: null,
        note: `Connected through Crossmint, not Reason's own browser, so there is no own-browser sign-in to check: orders are placed with the saved ${viaStore.name} sign-in.`,
      };
    }
    return {
      ...common,
      status: "not_connected",
      why: last
        ? `the last check said ${last.state}`
        : "nobody has signed in to this site in Reason's browser on this machine",
      owner_must_supply: p.supply,
    };
  }

  // Nothing written for it yet. This comes first: credentials for an integration that does not
  // exist still do not make it work, and saying "connectable" here would be the exact kind of
  // quiet overclaim this registry exists to prevent.
  if (p.built === false) {
    return {
      name, status: "not_connected", what: p.what, via: p.via,
      why: `nothing is built for ${name} yet`,
      needs: p.needs, missing, scopes_available: p.scopes,
      owner_must_supply: p.supply,
    };
  }
  if (missing.length) {
    return { name, status: "not_connected", what: p.what, via: p.via, needs: p.needs, missing, scopes_available: p.scopes, owner_must_supply: p.supply };
  }

  // An OAuth provider where the person's own half is a grant they gave on the provider's page. The
  // credentials being present says only that a link can be sent, so "connected" is read off the
  // token row for THIS conversation and nowhere else. The third state matters as much as the other
  // two: a grant the provider has stopped renewing is not the same as never having connected, and
  // the person gets told a different thing about each.
  if (p.oauth) {
    const dead = db.accountNeedsReconnect(conversationId, name);
    const tokens = db.getOauthTokens(conversationId, p.oauth);
    const common = {
      name, what: p.what, via: p.via, scopes_available: p.scopes,
      // Uber is the one provider here where "connected" and "can do the thing" come apart, because
      // the scope a ride needs is privileged and Uber hands it out to a short list of accounts. So
      // the status carries which of the two this is, in words. Read off the grant by src/uber.js,
      // never inferred from the credentials existing. See stateOf.
      ...(name === "uber_api" ? uberRideAccess(conversationId) : {}),
    };
    if (row && tokens) {
      // Every account this person has, not just the one a single-row lookup happens to land on.
      // "What's connected?" has to name all of them, and a provider where one account is live and
      // another has died has to say both halves — a status that reported only the live one would
      // leave somebody waiting on mail from a mailbox nothing can read any more.
      const live = db.liveAccounts(conversationId, name).map(r => r.account_label).filter(Boolean);
      const broken = db.accountsNeedingReconnect(conversationId, name).map(r => r.account_label).filter(Boolean);
      const defaultRow = db.listOauthTokens(conversationId, p.oauth).find(r => r.is_default);
      return {
        ...common, status: "connected",
        scopes: JSON.parse(row.scopes),
        ...(tokens.account_label ? { account: tokens.account_label } : {}),
        ...(live.length ? { accounts: live } : {}),
        ...(live.length > 1 && defaultRow?.account_label ? { default_account: defaultRow.account_label } : {}),
        ...(broken.length ? { needs_reconnect: broken } : {}),
        connected_at: stamp(row.connected_at), revoked_at: null,
      };
    }
    if (dead) {
      return {
        ...common, status: "needs_reconnect",
        ...(dead.account_label ? { account: dead.account_label } : {}),
        why: dead.evidence || `${p.oauth} will not renew the connection any more`,
        since: dead.checked_at ? stamp(dead.checked_at) : null,
      };
    }
    return { ...common, status: "connectable" };
  }

  if (!row) return { name, status: "connectable", what: p.what, via: p.via, scopes_available: p.scopes };
  return {
    name, status: "connected", what: p.what,
    scopes: JSON.parse(row.scopes), connected_at: stamp(row.connected_at), revoked_at: null,
  };
}

export function listAccounts(conversationId) {
  const known = Object.keys(PROVIDERS).map(n => accountStatus(conversationId, n));
  const revoked = db.accountHistory(conversationId)
    .filter(r => r.revoked_at)
    .map(r => ({ name: r.name, status: "revoked", scopes: JSON.parse(r.scopes), connected_at: stamp(r.connected_at), revoked_at: stamp(r.revoked_at) }));
  return { accounts: known, revoked_history: revoked };
}

// ---------- the spending cap ----------
//
// A confirm gate stops one thing at a time. It cannot stop twenty approved things in an afternoon,
// and "they said yes to each of them" is true and no comfort when the total is four figures. So
// there is a second limit, counted per person per day in the database (`spend`), and checked before
// a commit goes through rather than noticed afterwards.
//
// **Where the number comes from, and what that costs in honesty.** The amount is read out of the
// details the owner actually approved — the one-line `what` the gate already holds, which is the
// same string they were shown. That is the only number in the system that somebody has agreed to.
// It has two consequences worth being plain about rather than hiding:
//
//   - A commit whose approved details name no amount counts as nothing, so the cap cannot see it.
//     That is why `browser_submit` separately refuses to commit on one of these sites when the page
//     shows a price and the approval does not (`src/tools.js`) — the two guards together are what
//     make "nothing big slips past the cap" true, and neither does it alone.
//   - A number that is named but is not a charge — "$25 per person cancellation hold" — counts
//     anyway. Over-counting a hold is the safe direction to be wrong in, and `spend_list` shows
//     every line so an over-count can be seen for what it is.

const MONEY = /(?:(?:US)?\$|USD\s*)\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s?(?:dollars|usd)\b/gi;

/**
 * Every money amount in a line, in cents. Dollars only, because that is what the sites in the
 * registry quote and guessing at a currency from a bare number is how $40 becomes ¥40.
 */
export function amountsIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(MONEY)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/,/g, "");
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) out.push(Math.round(n * 100));
  }
  return out;
}

/** The biggest amount named, which on a checkout page is the total rather than a line item. */
export function largestAmount(text) {
  const all = amountsIn(text);
  return all.length ? Math.max(...all) : null;
}

export const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/** The day a cap is counted against, in the install's timezone rather than UTC. */
export function spendDay(nowMs = clock.now()) {
  return new Date(nowMs).toLocaleDateString("en-CA", { timeZone: config.installTz });
}

/**
 * Would committing this amount take them over the day? Returns `{ ok: true, … }` or a refusal the
 * tool must hand back as it is.
 */
export function checkSpendCap(conversationId, cents, { day = spendDay() } = {}) {
  // The person's own daily limit when they set one, else the install's default (src/spendcap.js).
  const theirs = spendcap.capFor(conversationId);
  const capCents = theirs.cents;
  const used = db.spentToday(conversationId, day);
  if (!capCents) return { ok: true, capped: false, spent_today: used.cents, cap: 0 };
  if (!cents) return { ok: true, capped: true, spent_today: used.cents, cap: capCents, amount: 0, own: theirs.own };
  if (used.cents + cents > capCents) {
    const say = spendcap.overCapLine(conversationId, { spent: used.cents, amount: cents });
    return {
      ok: false, blocked: "over_daily_cap",
      cap: capCents, spent_today: used.cents, amount: cents, left: Math.max(0, capCents - used.cents), own: theirs.own,
      say,
      error: `That is ${money(cents)} and their daily limit is ${money(capCents)}${theirs.own ? " (they set it themselves)" : " (the default here)"}, of which ${money(used.cents)} is already committed`
        + ` across ${used.count} thing(s) — so there is ${money(Math.max(0, capCents - used.cents))} left and this does not fit. Nothing was committed.`
        + ` Say it in their terms, once: "${say}" — the limit, where this would take them, and that they can change it in Settings → Shopping or by telling you a new limit.`
        + ` Never quote words for them to type. If they name a new limit, spend_limit_set is how it changes (a raise above the default is confirmed first). Do not retry the payment until the limit allows it.`,
    };
  }
  return { ok: true, capped: true, spent_today: used.cents, cap: capCents, amount: cents, left: capCents - used.cents - cents, own: theirs.own };
}

/** Written the moment a commit really goes through, so the cap counts what happened. */
export function noteSpend({ conversationId, cents, what = "", site = "", confirmationId = null }) {
  if (!cents) return null;
  return db.recordSpend({ conversationId, day: spendDay(), cents, what, site, confirmationId });
}

export function spendToday(conversationId) {
  const day = spendDay();
  const { cents, count } = db.spentToday(conversationId, day);
  const theirs = spendcap.capFor(conversationId);
  const capCents = theirs.cents;
  return {
    day, spent: money(cents), spent_cents: cents, commits: count,
    cap: capCents ? money(capCents) : "no cap set",
    cap_set_by: theirs.own ? "them" : "the default here",
    default_cap: theirs.default_cents ? money(theirs.default_cents) : "none",
    most_they_can_set: money(spendcap.SELF_MAX_CENTS),
    left: capCents ? money(Math.max(0, capCents - cents)) : null,
    lines: db.listSpend(conversationId, day).map(r => ({ at: stamp(r.at), amount: money(r.cents), what: r.what, site: r.site })),
    counted_from: "the amounts named in what was approved, biggest per commit. A commit whose approved details named no amount is not in this total.",
  };
}

// ---------- the limits the person sets ----------
//
// The daily cap above is the OPERATOR's safety net: one number in the environment, the same for
// everybody on the install, and it stays exactly as it was. These two are the person's own, and
// they are a different kind of thing:
//
//   per_purchase  the most one thing may cost without them being asked
//   monthly       the most that may be committed in a calendar month
//
// They are not guessed and they have no default. Before the first action that would ever spend
// money for somebody who has not set them, the gate stops and the model asks once, in one line —
// which is Omari's decision about this, in his words: "for the caps, we should let the users set it
// up: when they get to a situation for the first time where they have to set this, we can ask them."
//
// A number they set is a limit on what Reason may do ON ITS OWN. It is not a limit on them: a
// purchase over the per-purchase cap, or one that would cross the month, still goes through when
// they say yes to that one — and saying yes to one thing does not raise either number. That
// asymmetry is the whole point of having them.

/** The month a cap is counted against, in the install's timezone. The day's first seven characters. */
export function spendMonth(nowMs = clock.now()) {
  return spendDay(nowMs).slice(0, 7);
}

/** Their two numbers, as a person reads them, or null when they have not set any. */
export function capsView(conversationId) {
  const caps = db.getSpendCaps(conversationId);
  if (!caps) return null;
  const month = spendMonth();
  const used = db.spentThisMonth(conversationId, month);
  return {
    per_purchase: money(caps.per_purchase_cents),
    monthly: money(caps.monthly_cents),
    month,
    spent_this_month: money(used.cents),
    left_this_month: money(Math.max(0, caps.monthly_cents - used.cents)),
    commits_this_month: used.count,
    ...(caps.said ? { they_said: caps.said } : {}),
    set: stamp(caps.set_at),
  };
}

/** The block the gate returns before the first thing that would ever spend their money. */
export function needsCaps(conversationId, ownerName = config.ownerName) {
  return {
    ok: false, blocked: "needs_caps",
    error: `${ownerName} has not set a spending limit, and this would spend money, so nothing was done.`
      + ` Ask once, in one line, for both numbers — the most you should ever spend on one thing without asking, and the most per month —`
      + ` then save them with caps_set and do this again. Ask for both in the same line; do not ask twice, do not suggest numbers,`
      + ` and do not do anything that costs money until they have answered.`,
    ask: `before i spend anything — what's the most i should ever spend on one thing without checking with u, and what's the max per month?`,
  };
}

/**
 * Does this amount fit inside the limits they set? Returns `{ ok: true, … }` or a refusal.
 *
 * `hasYes` is what makes the two directions different. Over either number, a yes for THIS purchase
 * lets it through and changes nothing about the limits; without one — which means it was about to go
 * through on a standing permission — it is refused and they are asked. A permission cannot raise a
 * cap, and neither can a yes.
 */
export function checkCaps(conversationId, cents, { hasYes = false, now = clock.now(), ownerName = config.ownerName } = {}) {
  const caps = db.getSpendCaps(conversationId);
  if (!caps) return needsCaps(conversationId, ownerName);
  const view = capsView(conversationId);
  if (!cents) return { ok: true, caps: view };

  const month = spendMonth(now);
  const used = db.spentThisMonth(conversationId, month);

  if (cents > caps.per_purchase_cents) {
    if (!hasYes) {
      return {
        ok: false, blocked: "over_per_purchase", caps: view, amount: money(cents),
        error: `That is ${money(cents)} and ${ownerName} said never to spend more than ${money(caps.per_purchase_cents)} on one thing without asking,`
          + ` so this needs a yes even though they told you not to check on these. Nothing was committed.`
          + ` Say the real total, say what their own limit is, and ask once — a yes for this one does not raise the limit.`,
      };
    }
    return { ok: true, caps: view, over_per_purchase: true, note: `This is over the ${money(caps.per_purchase_cents)} they set for one thing. It is going through because they said yes to THIS one. Their limit is unchanged — do not treat it as raised.` };
  }

  if (used.cents + cents > caps.monthly_cents) {
    if (!hasYes) {
      return {
        ok: false, blocked: "over_monthly", caps: view, amount: money(cents),
        error: `That is ${money(cents)} and ${money(used.cents)} of ${ownerName}'s ${money(caps.monthly_cents)} for ${month} is already committed`
          + ` across ${used.count} thing(s), so this would cross the month and needs a yes. Nothing was committed.`
          + ` Say the total, what is already spent this month and what is left, and ask once — a yes for this one does not raise the monthly limit.`,
      };
    }
    return { ok: true, caps: view, over_monthly: true, note: `This crosses the ${money(caps.monthly_cents)} they set for ${month}. It is going through because they said yes to THIS one, and the monthly limit is unchanged.` };
  }

  return { ok: true, caps: view, left_this_month: money(caps.monthly_cents - used.cents - cents) };
}

// ---------- a payment whose outcome nobody knows ----------
//
// The one failure where doing nothing is right and trying again is the mistake. A commit that throws
// after the button has been pressed may have gone through: the shop has the order, or it does not,
// and nothing on this machine can tell which. A retry is then the only move that can take somebody's
// money twice, so it is blocked in code rather than discouraged in a prompt.
//
// What unblocks it is a yes given AFTER the outcome went unknown. An older yes cannot — it was given
// before anybody knew there was a problem — and a standing permission cannot, because the person has
// not been told. That is "until the person says so", enforced with a timestamp.

/** Written at the moment a commit's outcome stops being knowable. */
export function noteUnknownOutcome({ conversationId, action, target = "", why = "", cents = null }) {
  const saved = db.recordUnknownOutcome(conversationId, { action: toolName(action), target: normalizeTarget(target), why, cents });
  // Money or a message may or may not have gone: the owner hears now, not on the next ops pass.
  try {
    incidents.raise({
      key: `unknown:${toolName(action)}`, area: /purchase|buy|book/.test(toolName(action)) ? "purchases" : "actions", covers: "unknown",
      what: `${toolName(action)} ended with an unknown outcome — it may or may not have happened${cents != null ? ` ($${(Number(cents) / 100).toFixed(2)})` : ""}`,
      who: `${conversationId}${target ? ` · ${String(target).slice(0, 80)}` : ""}${cents != null ? ` · $${(Number(cents) / 100).toFixed(2)}` : ""}`,
      error: why, tried: "sent once; never resent, so nothing happens twice",
      next: "the provider's own record (AgentCard dashboard / order, or the sent folder), then clear it on /ops",
    });
  } catch { /* an alert never breaks the record */ }
  return saved;
}

/**
 * The refusal for retrying something whose outcome is unknown, or null to carry on.
 *
 * A pure check, and it runs BEFORE the confirm gate. That order is the whole value of it: the yes
 * that was spent on the attempt nobody knows the outcome of is also stale, spent or both, and the
 * gate's own refusal ("that yes was already used, ask again") would send the model off to collect a
 * fresh one without ever telling the person that something may have gone through. The first thing
 * they hear has to be that nobody knows.
 *
 * What lifts it is a yes granted AFTER the outcome went unknown — a timestamp, not a flag, so an
 * older yes cannot and a standing permission cannot. The row is closed by the tool once it has a
 * definite answer: see settleUnknownOutcome.
 */
export function retryBlocked({ conversationId, action, target = "", confirmationId = null }) {
  const row = db.openUnknownOutcome(conversationId, toolName(action), normalizeTarget(target));
  if (!row) return null;
  const fresh = confirmationId ? db.getConfirmation(conversationId, confirmationId) : null;
  if (fresh?.granted_at && fresh.granted_at > row.at) return null;
  return {
    ok: false, blocked: "outcome_unknown", unknown_since: stamp(row.at), what: row.target,
    error: `The last attempt at this ended with nobody knowing whether it went through${row.why ? ` (${row.why})` : ""},`
      + ` at ${stamp(row.at)}. It is not being retried: the shop may already have it, and trying again is the one thing that can take`
      + ` their money twice. Tell them exactly that — that you do not know whether it went through — then search their mail yourself`
      + ` (gmail_search for the shop's confirmation or receipt since then, gmail_read) and say what you found, or that nothing has come; if their email is not connected, say you can't see it and offer google_connect. Never tell them to check their email. Then ask whether to try again. Only their yes, given now, lets it through${row.cents ? `, and it would be ${money(row.cents)}` : ""}.`,
  };
}

/**
 * Close the open unknown outcome for this action, because this attempt has a definite answer.
 *
 * Called by the tool at the moment it knows — never by the check above, which has to stay pure so
 * that a refusal between the check and the press cannot quietly clear a block nobody resolved.
 */
export function settleUnknownOutcome({ conversationId, action, target = "", confirmationId = null }) {
  const row = db.openUnknownOutcome(conversationId, toolName(action), normalizeTarget(target));
  if (!row) return null;
  db.clearUnknownOutcome(row.id, { confirmationId });
  return row.id;
}

// ---------- receipts ----------
/** Host, the way a receipt should read it: "rtings.com", not "https://www.rtings.com/reviews/...". */
function siteName(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return String(url ?? "").slice(0, 60); }
}

/**
 * The line a receipt carries when the usual rules about how Reason writes to other people were
 * skipped because the person said to send it exactly as it was.
 *
 * On the row rather than only in the result, because that override is the one thing here that code
 * cannot check: nothing can prove they really said it. What code can do is make sure it is never
 * invisible — "why did this go out with an emoji in it and no sign-off" has an answer.
 */
const exactlyAsAsked = (out) => (out?.sent_exactly_as_asked
  ? ` Sent word for word, unchecked, because they said: "${out.sent_exactly_as_asked}".`
  : "");

/** One plain line per action, written from the tool's real result. This is what ledger_list reads back. */
export function receiptFor(action, input, out) {
  const ok = out?.ok !== false && !out?.error;
  const tail = ok ? "" : ` — failed: ${out?.error ?? out?.blocked ?? "unknown error"}`;
  switch (action) {
    case "account_connect":
      return ok
        ? `Connected the ${input.name} account (${(out.account?.scopes ?? []).join(", ") || "no scopes"}).`
        : `Tried to connect the ${input.name} account${tail}`;
    case "account_revoke":
      return ok ? `Revoked the ${input.name} account.` : `Tried to revoke the ${input.name} account${tail}`;
    // Saved sign-ins and Spotify. Each line says what really came back, because "is it signed in"
    // and "did that actually play" are both questions the ledger has to be able to answer weeks
    // later without taking anybody's word for it.
    case "signin_status":
      return ok
        ? `Asked ${input.site} whether they are signed in — ${out.state}: ${out.why}.`
        : `Could not check the ${input.site} sign-in${tail}`;
    case "spotify_control":
      return ok
        ? `Spotify: ${out.did}${out.started ? ` (${out.started})` : ""}. Spotify accepted it; it does not confirm what is now playing.`
        : `Spotify would not ${input.action}${tail}`;
    case "spotify_queue":
      return ok ? `Queued ${out.queued} on Spotify.` : `Did not queue ${input.uri}${tail}`;
    case "spotify_playlist_create":
      return ok
        ? `Made the Spotify playlist "${out.playlist?.name}" (${out.added} track(s)${out.playlist?.public ? ", public" : ", private"}): ${out.playlist?.link || "no link returned"}`
          + `${out.partial ? ` — ${out.partial}` : ""}`
        : `Could not make the Spotify playlist "${input.name}"${tail}`;
    case "spotify_playlist_add":
      return ok
        ? `Added ${out.added} track(s) to Spotify playlist ${input.playlist_id}.`
        : `Could not add to Spotify playlist ${input.playlist_id}${tail}`;
    // Which document, in whose Drive, and the link — not a word of what is in it. A person asking
    // "what did you put in that doc" opens the doc; the receipt's job is to say that one exists.
    case "drive_create":
      return ok
        ? `Made a Google Doc "${out.file?.name ?? input.title}" in ${input.account || "their"} Drive (${String(input.text ?? "").length} characters): ${out.link || "no link returned"}`
        : `Could not make the document "${input.title}" in ${input.account || "their"} Drive${tail}`;
    // Organising, 2026-10-07. Each line is what somebody asking "what did you do to my drive" wants
    // back: which file, by the name Google gave it, where it went, and in whose Drive. Never a
    // folder's contents and never a file's — a ledger row is not where somebody's documents live.
    case "drive_folder_create":
      return ok
        ? `Made the folder "${out.folder?.name ?? input.name}" in ${input.account || "their"} Drive${input.inside ? ` (inside ${input.inside})` : ""}.`
        : `Could not make the folder "${input.name}" in ${input.account || "their"} Drive${tail}`;
    case "drive_rename":
      return ok
        ? `Renamed "${out.was}" to "${out.now}" in ${input.account || "their"} Drive.`
        : `Could not rename ${input.file_id} in ${input.account || "their"} Drive${tail}`;
    // One row per FILE, written by the handler as each move really happens — so this is always about
    // one file whether the tool was called with one or with forty, and a batch that stopped halfway
    // leaves rows for exactly the ones that moved.
    case "drive_move": {
      const one = (input.file_ids ?? [])[0] ?? "?";
      return ok
        ? `Moved "${out.name || one}" into folder ${input.into} in ${input.account || "their"} Drive.`
        : `Did NOT move ${one} into folder ${input.into} in ${input.account || "their"} Drive${tail}`;
    }
    case "drive_trash":
      return ok
        ? out.status === "already_binned"
          ? `"${out.name}" was already in the bin in ${input.account || "their"} Drive — nothing was done.`
          : `Put "${out.name ?? input.file_id}" in the bin in ${input.account || "their"} Drive. NOT deleted: Google keeps it 30 days and it can be restored.`
        : `Could not bin ${input.file_id} in ${input.account || "their"} Drive${tail}`;
    // Who got access to what — the one Drive row somebody really audits, because it is the only one
    // here that reaches a person who is not them. A bare link reached nobody and says so.
    case "drive_share":
      if (!input.with_email) {
        return ok
          ? `Handed them the link to "${out.name ?? input.file_id}" in ${input.account || "their"} Drive. Nobody else was given access.`
          : `Could not get the link for ${input.file_id} in ${input.account || "their"} Drive${tail}`;
      }
      return ok
        ? `Gave ${out.who ?? input.with_email} ${out.role ?? input.role ?? "reader"} access to "${out.name ?? input.file_id}" in ${input.account || "their"} Drive. Google emailed them.`
        : `Did NOT give ${input.with_email} access to ${input.file_id} in ${input.account || "their"} Drive${tail}`;
    case "drive_upload":
      return ok
        ? `Put "${out.file?.name ?? input.name ?? input.path}" (${out.kb ?? "?"}KB) in ${input.account || "their"} Drive: ${out.link || "no link returned"}`
        : `Could not put ${input.name || input.path} in ${input.account || "their"} Drive${tail}`;
    // Which of their files went back to them, in what format, by which route — and whether the
    // temporary copy the conversion route makes inside their Drive really came out again. That last
    // one is the whole reason this row is worth keeping: "is there a stray file in my Drive" has to
    // be answerable months later from the ledger, not from whether anybody remembered to mention it.
    case "drive_send":
      return ok
        ? `Sent ${input.as === "docx" ? "a Word copy" : "a PDF"} of "${out.from_file?.name ?? input.file_id}" from ${input.account || "their"} Drive`
          + ` into their thread (${out.bytes ?? "?"} bytes, ${out.how ?? "route not recorded"})`
          + (out.temp_copy_deleted === false ? " — AND THE TEMPORARY COPY IN THEIR DRIVE WAS NOT DELETED" : "")
          + `. ${out.sent ? "It really went." : "It was made and did NOT go."}`
        : `Could not send "${out.from_file?.name ?? input.file_id}" from ${input.account || "their"} Drive as ${input.as === "docx" ? "a Word document" : "a PDF"}`
          + (out.temp_copy_deleted === false ? " — AND THE TEMPORARY COPY IN THEIR DRIVE WAS NOT DELETED" : "")
          + tail;
    // Not a tool. Written whenever something that came from outside carried one of the manipulation
    // shapes, so "did anyone try it on?" is a question the ledger answers rather than a question
    // about whether somebody remembered to say so at the time.
    case "flagged_content":
      return `FLAGGED: ${out.source ?? "something from outside"} contained `
        + `${(out.flagged ?? []).map(f => `${f.what} ("${f.quote}")`).join("; ")}.`
        + ` It arrived from ${input.from}. Nothing was done about it, which is correct — it is reported, never acted on.`;
    case "web_lookup":
      return ok ? `Read ${out.url} ("${out.title || "untitled"}").` : `Tried to read ${input.url}${tail}`;
    case "web_search":
      if (!ok) return `Tried to search for "${input.query}"${tail}`;
      return `Searched ${out.provider} for "${input.query}"${input.sites?.length ? ` (only ${input.sites.join(", ")})` : ""}`
        + ` — ${out.count} result(s)${out.count ? `: ${out.results.slice(0, 5).map(r => siteName(r.url)).join(", ")}` : ""}.`;
    // The receipt names every source, because the point of research is that the answer is checkable.
    // "Where did the £799 come from" has to be answerable from the ledger months later, so the sites
    // that were read, the ones that were only snippets and the ones that failed are all on the line.
    case "research": {
      if (!ok) return `Tried to research "${input.question ?? `#${input.research_id}`}"${tail}`;
      const read = (out.sources ?? []).map(s => s.site);
      const snip = [...new Set((out.snippets_only ?? []).map(s => s.site))];
      const miss = (out.skipped ?? []).map(s => s.site);
      const bits = [
        `Researched "${out.question}" — ${out.searches_used} search(es), ${out.pages_read} page(s) read`,
        read.length ? `read: ${[...new Set(read)].join(", ")}` : "read nothing",
        snip.length ? `snippets only: ${snip.slice(0, 8).join(", ")}` : null,
        miss.length ? `could not read: ${[...new Set(miss)].join(", ")}` : null,
        out.cut_short ? `stopped by the ${out.cut_short} cap` : null,
      ].filter(Boolean);
      return bits.join("; ") + ".";
    }
    case "browser_open":
      return ok ? `Opened ${out.url} in the browser ("${out.title || "untitled"}").` : `Tried to open ${input.url}${tail}`;
    // Which tier answered goes on the receipt, because "did you actually watch that video" is a
    // question the ledger has to be able to answer honestly weeks later — and the answer is always
    // no. It also records whether listening cost anything, since that is billed per minute.
    case "video_understand": {
      if (!ok) return `Tried to get at the video ${input.url}${tail}`;
      const what = `"${out.title || out.url}"`;
      if (out.tier === "watch") {
        return out.watched?.cached
          ? `Used the account of ${what} that ${out.watched.by ?? "a video model"} made when it watched this before — nothing was spent this time.`
          : `WATCHED ${what} — handed the link to ${out.watched?.by ?? "a video model"}, which saw the picture and heard the sound. Nothing was downloaded.`;
      }
      if (out.tier === "listen") {
        return out.heard?.cached
          ? `Used the transcript of ${what} that ${out.heard.by ?? "a video model"} made before — nothing was spent this time. Audio only; the picture was never seen.`
          : `Downloaded the AUDIO ONLY of ${what} and had it transcribed by ${out.heard?.by ?? "a video model"}. The audio was deleted. The picture was never seen.`;
      }
      if (out.tier === "captions") {
        const span = `${out.covers ?? "whole thing"}${out.trimmed ? `; ${out.trimmed.missing} not read` : ""}`;
        return `Read the ${out.captions?.source === "creator" ? "creator's" : "auto-generated"} captions of ${what} (${span}). Words only; nothing watched it.`;
      }
      return `Could only read what the page says about the video ${what} — nothing was read, watched or listened to.`;
    }
    case "browser_click":
      return `Stopped short of pressing '${out.element ?? input.ref}' — that commits something and needs a yes first.`;
    case "browser_submit":
      if (ok) return `Submitted on ${out.landed_on ?? out.from_url}: ${input.what}. Pressed '${out.pressed}'.`;
      // The one receipt that must not read as a failure. The button was pressed and then something
      // broke, so whether the shop took the order is genuinely unknown — and a row saying "failed"
      // is how somebody later decides it is safe to do again.
      if (out?.blocked === "outcome_unknown") {
        return `OUTCOME UNKNOWN on ${input.what}: the button was pressed and then ${out.error ?? "something broke"}.`
          + ` Nobody knows whether it went through. Not retried.`;
      }
      return `Tried to submit: ${input.what}${tail}`;
    // The effect goes on the line because it is a thing the person actually saw happen on their
    // screen, and because "one an hour" has to be auditable: a ledger that only records the words
    // cannot answer "how often does it do the confetti". A dropped one says so, and why.
    case "message_send":
      return ok
        ? `Texted ${out.sent_to}: "${input.text}".${out.style ? ` Sent with the '${out.style}' screen effect.` : ""}`
          + `${out.style_dropped ? ` No effect: ${out.style_dropped}` : ""}`
          + exactlyAsAsked(out)
        : `Did not text ${input.to}${tail}`;
    // Email has had no receipt of its own, which left "did you send it, and what did it say" being
    // answered by `gmail_send ran.` A sent email cannot be unsent, so the row says who it reached,
    // from which of their addresses, and the subject. The body is in `attempted` either way.
    case "gmail_send":
      return ok
        ? `Emailed ${(out.to ?? []).join(", ") || "nobody named"} from ${out.from || "their address"}: "${out.subject || "(no subject)"}"`
          + `${out.in_thread ? ", in the existing thread" : ""}. It cannot be unsent.${exactlyAsAsked(out)}`
        : `Did not send the email to ${[].concat(input.to ?? []).join(", ") || "whoever it was for"}${tail}`;
    // What the model thought the moment was, in its own words, next to which effect it picked.
    // Written when the effect is marked rather than when the message lands, which is what the line
    // says: the reply goes out on the ordinary path straight after this.
    case "mark_moment":
      return ok
        ? `Marked the reply as a moment — ${input.moment} — so it went out with the '${input.effect}' screen effect.`
        : `No '${input.effect}' effect on the reply${tail}`;
    // A tapback leaves no bubble behind, so this row is the only record that anything was answered
    // at all. "Held" is its own outcome and reads as one: nothing was put on their message, and the
    // reaction is waiting on words. See src/tapbacks.js.
    case "react": {
      if (out?.held) return `Held a '${out.reaction}' tapback back — they had asked something, so it waits for the reply in words.`;
      if (!ok) return `Did not put a '${input.reaction}' tapback on their message${tail}`;
      return out.removed
        ? `Took the '${String(out.reaction).replace(/^-/, "")}' tapback back off their message (${out.reacted_to}).`
        : `Put a '${out.reaction}' tapback on their message (${out.reacted_to}) — no text was sent.`;
    }
    case "call_place":
      return ok
        ? `Rang ${out.to} to: ${input.goal}. Shared: ${(input.facts ?? []).join("; ") || "nothing"}.`
          + ` Opened with: "${out.announced}". ${out.recorded ? "Recorded" : "Not recorded"}.`
          + ` (call #${out.call_id}; the outcome is on the call record, not here.)`
        : `Did not ring ${input.to}${tail}`;
    // Not a tool the model can call. The ledger is append-only, so the audio that turns up after
    // a call cannot be written back onto the call's own row; it gets this row instead, carrying
    // the same target, so "what did you do" and "where is that recording" have one answer.
    case "access_grant":
      return ok
        ? `Let ${out.number} in — they have their own Reason now. In their words: "${out.quote}".`
        : `Did not let ${input.number} in${tail}`;
    case "access_decline":
      return ok
        ? `Said no to ${out.number}. In their words: "${out.quote}". Not asking again for a while.`
        : `Could not answer ${input.number}'s request${tail}`;
    case "admin_pause":
      return ok ? `Paused ${out.number} — stopped answering them, kept everything of theirs.` : `Could not pause ${input.number}${tail}`;
    case "admin_resume":
      return ok ? `Answering ${out.number} again.` : `Could not resume ${input.number}${tail}`;
    case "admin_remove":
      return ok ? `Removed ${out.number} — stopped answering them. Their data is kept.` : `Could not remove ${input.number}${tail}`;
    case "admin_block":
      return ok ? `Blocked ${out.blocked} for good: no replies, and never asked about again.` : `Could not block ${input.number}${tail}`;
    case "admin_delete":
      return ok ? `DELETED everything of ${out.deleted}'s. This cannot be undone.` : `Did not delete ${input.number}'s data${tail}`;
    // Subscriptions. The scan's line names the window and where it looked, because "you went
    // through my whole inbox" has to be answerable from a row rather than from the model's memory
    // of a turn that is long gone from the conversation.
    case "subscriptions_scan":
      return ok
        ? `Read ${input.months ?? 12} months of receipts in ${(out.accounts_searched ?? []).join(", ") || "their mail"}`
          + ` — ${out.candidates ?? 0} possible subscription(s) came back. Nothing was recorded by the scan itself.`
        : `Could not read their receipts${tail}`;
    case "subscription_cancel_start":
      if (out?.cant_do) return `Did not start cancelling ${input.merchant}: it goes by ${out.cant_do}, which Reason cannot do. Said so instead.`;
      if (out?.blocked === "not_signed_in") return `Could not start cancelling ${input.merchant}: ${out.service} says they are not signed in. Offered the sign-in link.`;
      if (!ok) return `Could not start cancelling ${input.merchant}${tail}`;
      return out.rail === "web"
        ? `Opened ${out.opened_url} to cancel ${input.merchant}. Nothing was pressed.`
        : `Drafted the written cancellation for ${input.merchant}${out.to ? ` to ${out.to}` : " with no address to send it to"}. Nothing was sent.`;
    // The row that matters most in this whole feature. It says what was pressed, and it says
    // whether a confirmation came back — because "you told me it was cancelled" has to be
    // checkable against what the page actually gave, months later and without taking anybody's word.
    case "subscription_cancel_commit":
      return ok
        ? `Pressed '${out.pressed}' to end ${input.merchant}: ${input.what}.`
          + (out.confirmation
            ? ` ${out.landed_on} confirmed it: ${out.confirmation}. Recorded as cancelled.`
            : ` The page gave NO confirmation, so it is recorded as cancelling and NOT cancelled.`)
        : `Did not end ${input.merchant}${tail}`;
    // Flights. The start row says what was opened and that nothing was pressed; the commit row is the
    // one somebody standing in an airport would come back and read, so it says what was pressed, what
    // the page gave back, and whether that was enough to call it a check-in.
    case "flight_checkin_start":
      if (out?.cant_do) return `Did not start the check-in on flight #${input.flight_id}: it goes by ${out.cant_do}, which Reason cannot do. Said so instead.`;
      if (out?.blocked === "too_early") return `Did not start the check-in on flight #${input.flight_id}: check-in does not open until ${out.opens}. Nothing was touched.`;
      if (out?.blocked === "not_signed_in") return `Could not start the check-in on flight #${input.flight_id}: ${out.airline} says they are not signed in and there was no confirmation code on it. Offered both ways round it.`;
      if (!ok) return `Could not start the check-in on flight #${input.flight_id}${tail}`;
      return `Opened ${out.opened_url} to check in on flight #${input.flight_id}. Nothing was pressed.`;
    case "flight_checkin_commit":
      if (out?.blocked === "would_spend_money") return `Did NOT check in on flight #${input.flight_id}: the page wanted paying (${out.why}) and Reason spends nothing on a check-in. Nothing was pressed; the page was handed back.`;
      if (out?.blocked === "airline_refused") return `Did NOT check in on flight #${input.flight_id}: the airline's own page said "${out.page_says}". Nothing was pressed.`;
      if (!ok) return `Did not check in on flight #${input.flight_id}${tail}`;
      return out.status === "checked_in"
        ? `Pressed '${out.pressed}' and CHECKED IN on flight #${input.flight_id}: ${input.what}.`
          + ` ${out.landed_on} confirmed it (${out.verified?.checked_in_because})`
          + `${out.verified?.seat ? `, seat ${out.verified.seat}` : out.verified?.boarding_position ? `, boarding ${out.verified.boarding_position}` : ""}.`
        : `Pressed '${out.pressed}' on flight #${input.flight_id} and the page did NOT confirm a check-in`
          + `${out.not_verified?.length ? ` (${out.not_verified.join("; ")})` : ""}. Recorded as checking_in and NOT checked in.`;
    case "page_create":
      return ok ? `Made the page "${input.title}": ${out.link}` : `Could not make the page "${input.title}"${tail}`;
    case "page_update":
      return ok ? `Changed the page "${out.title}" (revision ${out.revision}), same link: ${out.link}` : `Could not change page ${input.page_id}${tail}`;
    case "page_delete":
      return ok ? `Deleted the page "${out.title}" and everything on it.` : `Could not delete page ${input.page_id}${tail}`;
    // Something Reason went and found on its own and really told them. On the record like anything
    // else, and for the same reason: "what have you been up to" has to include the things nobody
    // asked for, and "why did you text me about that" has to be answerable weeks later from a row
    // rather than from the model's memory of what it was thinking at the time.
    case "notice_send":
      return ok
        ? `Told them${input.unprompted === false ? " on the end of a reply (not an interruption)" : ", unprompted"}: ${out.what}`
          + `${input.why_now ? ` — why then: ${input.why_now}` : ""}${input.urgent ? " [sent as urgent]" : ""}`
        : `Did not tell them about ${input.key}${tail}`;
    case "call_recording":
      return ok
        ? `Sent them the recording of call #${input.call_id}`
          + ` (${out.seconds ?? "?"}s, ${out.bytes ? Math.round(out.bytes / 1024) : "?"} KB ${out.format ?? ""}): ${out.file}`
        // Every call is recorded, so this is a broken promise and the receipt says so in those
        // words. "What went wrong today" has to be answerable from this table.
        : `RECORDING MISSING for call #${input.call_id} — the call was answered and there is no audio${tail}`;
    // The hard line (src/harm.js). The receipt names the kind and the count and never the words:
    // "what happened with that number" is answerable, and nothing here is something to reread.
    case "harm_refuse":
      return `Refused a message seeking help toward harm (${input.category}) before any model turn — strike ${input.strike} of ${out?.limit ?? "?"}. No tool ran; the refusal line was sent.`;
    case "harm_void":
      return `Voided ${input.ids?.length ?? 0} strike(s) the screen got wrong (${input.why || "false positive"}). They no longer count toward a pause.`;
    case "harm_withheld":
      return `Held back a reply to a borderline message: the outbound screen said ${input.screen} (${input.category}). A plain line was sent instead.`;
    // Standing check-ins (src/series.js). A series is an arrangement Reason keeps for weeks, so
    // "why does it ask me this every monday" and "i told you to stop that" are both questions the
    // ledger has to answer — with the schedule in the words the person was told, not a rule blob.
    case "series_set":
      return ok
        ? `Set a standing check-in: ${out.series.schedule} (${out.series.time_zone}), about ${out.series.what}. First one ${out.first}.`
        : `Did not set a standing check-in about "${input.note}"${tail}`;
    case "series_pause":
      return ok
        ? `Paused the standing check-in about ${out.series.what} (${out.series.schedule}) after ${out.series.checked_in}. Nothing forgotten; series_resume starts it again.`
        : `Did not pause series #${input.series_id}${tail}`;
    case "series_resume":
      return ok
        ? `Started the check-in about ${out.series.what} again (${out.series.schedule}); next one ${out.series.next}.`
        : `Did not resume series #${input.series_id}${tail}`;
    case "series_end":
      return ok
        ? `Stopped the standing check-in about ${out.series.what} (${out.series.schedule}) for good after ${out.series.checked_in}`
          + `${input.why ? ` — they said: "${input.why}"` : ""}.`
        : `Did not stop series #${input.series_id}${tail}`;
    // AgentCard. These are the rows somebody comes back to when they ask what was bought, and the
    // one thing each has to be exact about is whether money moved. A paused confirm and a placed
    // order are a tap apart and read almost the same in a conversation, so the receipt says which.
    case "vault_enroll":
      if (out?.already_enrolled) return `Did not send a vault link: they already have ${out.card ?? "a card"} stored with AgentCard.`;
      return ok
        ? `Sent the AgentCard vault link (session ${out.vault_session_id ?? "?"}) for them to store a card. Reason never sees the number.`
        : `Could not open an AgentCard vault session${tail}`;
    case "purchase":
      if (!ok) return `Could not get a cart for "${input.ask}"${tail}`;
      return out.cart
        ? `Shopped for "${input.ask}" and got a cart: ${out.cart_line ?? out.cart.total}. Nothing was confirmed and nothing was charged.`
        : `Shopped for "${input.ask}". AgentCard asked for more detail (${out.status}); no cart yet, nothing charged.`;
    case "flight_book":
      return ok
        ? `Started booking a flight on ${out.airline ?? "the airline"}'s site: ${out.flight ?? "a flight"} (searched at ${out.searched_price ?? "an unknown price"}). NOTHING WAS BOOKED OR CHARGED.`
        : `Did not start booking a flight${tail}`;
    case "purchase_confirm":
      if (out?.booking_state) return `Confirmed the flight ${out.cart_line ?? input.cart_hash}: AgentCard placed the order (${out.order_id || "no id"}, charge ${out.charge_status || "unreported"}). Booking state: ${out.booking_state}${out.booked ? "" : " — NOT ticketed"}.`;
      if (out?.blocked === "vault_approval_required") {
        return `Confirmed the cart ${out.cart_line ?? input.cart_hash} and AgentCard paused it for their passkey. NOTHING WAS CHARGED.`
          + ` The approval link went to them; the same confirm has to be run again after they approve.`;
      }
      if (out?.blocked === "cart_changed") return `Did NOT buy ${out.was ?? input.cart_hash}: the price moved between the yes and the confirm, so that cart is dead and a new total needs agreeing.`;
      if (out?.blocked === "outcome_unknown") return `Confirmed a cart at ${out.amount ?? "an unknown total"} and nothing came back. NOBODY KNOWS whether the order was placed. Not retried.`;
      if (out?.blocked === "declined") return `Did NOT buy ${out.cart_line ?? input.cart_hash}: AgentCard declined it (${out.decline_code || "no code"}). Nothing was charged.`;
      if (!ok) return `Did not confirm the cart ${input.cart_hash}${tail}`;
      if (out?.cancelled) return `Ordered ${out.cart_line ?? "a cart"} and AgentCard has CANCELLED that order (${out.order_id || "no id"}): ${out.reason || "no reason given"}. Not bought.`;
      return `BOUGHT ${out.cart_line ?? out.amount ?? "a cart"} with their vaulted card${out.card ? ` (${out.card})` : ""}.`
        + ` Order ${out.order_id || "with no id returned"}, charge ${out.charge_status || "unreported"}.`;
    case "purchase_track": {
      const which = input.order_id ? `order ${input.order_id}` : `purchase ${input.conversation_id}`;
      if (!ok) return `Could not track ${which}${tail}`;
      if (out?.read_from === "local_record") return `Read ${which} from Reason's own record (AgentCard not re-checked${out.live_check === "needs_reconnect" ? " — the card connection needs reconnecting" : ""}): ${out.cancelled ? `CANCELLED (${out.reason || "no reason given"})` : out.status}${out.amount ? `, ${out.amount}` : ""}.`;
      if (out?.cancelled) return `Read ${which}: AgentCard lists the order as CANCELLED (${out.reason || "no reason given"}). Nothing is coming.`;
      return `Tracked ${which}: ${out.order_number ? `the shop calls it ${out.order_number}` : "no order number from the shop yet"}, ${out.delivery_window || "no delivery window given"}.`;
    }
    case "directions":
      return ok ? `Made walking directions to ${out.name}${out.walk ? ` (${out.walk})` : ""}, a private link only they can open.` : `Could not make walking directions${tail}`;
    case "harm_pause":
      return `Paused this person's Reason after ${input.strikes} refused messages in ${input.window_hours}h (${(input.kinds ?? []).join(", ") || "unspecified"}). Nothing deleted; the master was told the count and the kind only.`;
    default:
      return ok ? `${action} ran.` : `${action} did not run${tail}`;
  }
}

/**
 * The input as the receipt keeps it.
 *
 * Normally the whole thing: "what did you do today" is answered from this table, and an email's
 * recipients and words are the answer. One exception, and it is one of size rather than of principle —
 * `drive_create` carries up to 200,000 characters of somebody's document, and the ledger does not need
 * a second copy of a file that is sitting in their own Drive with its link on the row. So the text is
 * kept as its length. Nothing is lost that cannot be read at the link.
 */
function ledgerInput(action, input) {
  if (action === "drive_create") {
    return { ...input, text: `(${String(input?.text ?? "").length} characters — the document itself is in their Drive)` };
  }
  // A walk's start is where they were standing (or said they were): the trip keeps it only until the walk
  // ends, the ledger never does: not the coordinates and not the words.
  if (action === "directions") {
    const { from_latitude, from_longitude, to_latitude, to_longitude, from, ...rest } = input ?? {};
    return { ...rest, ...(from_latitude != null || from ? { from: "(where they started)" } : {}) };
  }
  return input;
}

/** The result as the ledger keeps it: a walk's link without the owner's key, which opens it. */
function ledgerResult(action, out) {
  if (action === "directions" && out && typeof out.link === "string") return { ...out, link: out.link.replace(/\?k=[^&#\s]*/, "") };
  return out;
}

/**
 * Writes the ledger row for one outside-world tool call and returns the row id.
 *
 * `permission` is the standing permission the action went through on, when it went through on one
 * instead of on a yes. It is appended to the receipt in their own words rather than as an id,
 * because the question somebody asks weeks later is "why did it do that without asking me" and the
 * answer has to be the sentence they said, not a row number they would have to go and look up.
 */
export function ledgerWrite({ conversationId, action, input, out: given, target = "", confirmationId = null, permission = null }) {
  // A passenger's details stay sealed in flight_travelers; the ledger keeps that a call happened.
  // So does what was typed into a password, code or card box, and what a secret box of a page held
  // (privacy.sealCall: the same rule the tool log uses).
  const sealed = sealCall(action, input, given);
  const out = sealed.out;
  input = sealed.input;
  // `unknown` is its own outcome and not a kind of error. "It failed" and "nobody knows whether it
  // went through" lead to opposite next moves — one is safe to retry and the other is the one thing
  // that can charge somebody twice — so the row has to be able to say which.
  const outcome = out?.blocked === "outcome_unknown" ? "unknown"
    : out?.blocked ? "blocked"
    : (out?.ok === false || out?.error) ? "error" : "ok";
  const receipt = receiptFor(action, input, out)
    + (permission && outcome === "ok" ? ` No yes was asked for — under: "${permission.said}".` : "");
  return db.recordAction({
    conversationId, action, target, attempted: ledgerInput(action, input), outcome, result: ledgerResult(action, out),
    receipt,
    confirmationId: confirmationId ?? out?.confirmation?.id ?? null,
    permissionId: permission?.permission_id ?? null,
  });
}
