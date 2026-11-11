// Outbound delivery that survives failure, and tells somebody when it doesn't.
//
// The hole this fills: a reply that failed to send used to be logged to stderr and dropped. The
// first real text anybody ever sent Reason was lost exactly that way — Reason wrote an answer,
// the send failed, the answer went nowhere, and the person on the other end just saw silence.
// Nothing in the system knew, so Reason carried on as though it had replied.
//
// Four promises, in the order they matter:
//
//   1. **A message is a row before it is an attempt.** Every outbound message is written down with
//      its state, its attempt count and its last error. Kill the process at any point and the next
//      one can see what was owed and to whom.
//   2. **Retry what can work, never what cannot.** The classifier is canRetry() in the Sendblue
//      adapter, built from Sendblue's own error table: a 429, a 5xx, a dropped socket come back.
//      A bad number, "cannot send to self", an opted-out contact, an unverified contact on the free
//      line do not — and retrying those is not persistence, it is six texts to somebody who said
//      stop. Backoff is exponential with a ceiling.
//   3. **Never twice.** Sendblue's /api/send-message has no idempotency key, so this is enforced
//      here: one row per idempotency key, one in-flight attempt per row, and a row that reached
//      `sent` is never attempted again. The hard case is a crash mid-attempt, where the request may
//      have landed and the answer was lost. Nobody here knows, so nobody here guesses: the row goes
//      to `unknown` and the provider is ASKED (channel.findSent). If it cannot say, the message is
//      marked failed and said out loud, because losing one message loudly beats texting twice.
//   4. **Somebody is always told.** When a message finally cannot be delivered, the next turn in
//      that conversation opens with the plain fact that the last reply never arrived and why, so
//      Reason can say so instead of assuming it landed. If the undelivered message was to anyone
//      other than the account owner, the owner is told too — Reason said it would text Kofi, and
//      the person who needs to know Kofi never got it is the owner.
//
// What is deliberately NOT in here: deciding whether Reason was ALLOWED to send something. That is
// the `message_send` tool and its confirm gate, upstream of every line of this file.
import * as db from "./db.js";
import { config, clock, isOwnLine } from "./config.js";
import { freshRideLinks } from "./ridelinks.js";
import * as incidents from "./incidents.js";
import { withoutNoReply } from "./plain.js";
import { effectPartIndex } from "./links.js";

/** What a send returns when the silence marker was all there was: nothing went, on purpose. */
const NOTHING_LEFT = Object.freeze({ ok: false, not_sent: true, silent: true, retryable: false, error: "Not sent: once NO_REPLY was taken off there was nothing left to send." });

const SEC = 1000;

/**
 * How long before the next try. Exponential from a base, with a ceiling, because the two failures
 * worth retrying have different shapes: a dropped socket clears in a second, and a 429 wants a
 * window to pass. Starting at 5s and topping out at 5 minutes covers both without a message
 * sitting unsent for an hour.
 *
 * No jitter. There is one of these processes and a handful of messages; jitter would buy nothing
 * and make the tests lie about when something happens.
 */
export function backoffMs(attempts) {
  const base = config.outboxBackoffMs;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), config.outboxBackoffMaxMs);
}

/**
 * One outbound message, durably.
 *
 * Returns the first attempt's result, so a caller that wants to know whether the text has gone
 * right now still finds out right now — `message_send` tells the model "this actually went out"
 * only on `ok: true`, and that has to stay true. The difference is what happens on failure: the row
 * stays, and it either comes back or somebody gets told.
 *
 * `queued: true` on a failure means "not delivered yet, but not lost either".
 */
export async function sendDurable({ channel, router, conversationId, to, text, chatId = null, media = null, sendStyle = null, replyTo = null, idempotencyKey = null, toOwner = false, log = () => {} }) {
  // The silence marker off before the row is written, so the history the row becomes never has it
  // either (src/plain.js withoutNoReply). Only the marker and no file: nothing is sent.
  const quiet = withoutNoReply(text, { path: "outbox", log });
  if (quiet.stripped) {
    if (quiet.empty && !media) return { ...NOTHING_LEFT };
    text = quiet.text;
  }
  // A ride link goes out as today's builder makes it, wherever the words came from (src/ridelinks.js).
  text = await freshRideLinks(text, { conversationId, log });
  const idemKey = idempotencyKey || `auto:${channel}:${conversationId}:${to}:${clock.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const { fresh, row } = db.enqueueOutbound({
    idemKey, conversationId, channel, address: to, chatId,
    body: text ?? "", media, sendStyle, replyTo, toOwner, maxAttempts: config.outboxMaxAttempts,
  });

  // Asked twice for the same message. Whatever became of it the first time is the answer; nothing
  // is sent again.
  if (!fresh) {
    log({ outbox: row.id, already: row.state, idem: idemKey });
    if (row.state === "sent") return { ok: true, outbox_id: row.id, duplicate: true, delivered: { channel, to, message_id: row.message_id } };
    if (row.state === "failed") return { ok: false, outbox_id: row.id, duplicate: true, error: row.last_error, retryable: false };
    return { ok: true, outbox_id: row.id, duplicate: true, queued: true, note: "that exact message is already in the outbox" };
  }

  return await attempt({ id: row.id, router, log });
}

/**
 * Several messages that are one answer, sent in that order and kept in it.
 *
 * This is what a reply with a link in it becomes: the bare URL, then the words about it
 * (src/links.js). Two things have to be true and neither is true of simply calling sendDurable
 * twice:
 *
 *   1. **Every part is a row before ANY of them is an attempt.** So a process that dies between
 *      the link and its summary has both written down, and the chain is already in the database
 *      for the next one to finish.
 *   2. **Nothing is attempted before the part in front of it has been sent.** The chain is on the
 *      rows (`after_id`), so it holds for the retry an hour later too, not just for this loop.
 *      That is also why the loop stops at the first part that did not go: the rest are queued, due
 *      only once their predecessor is sent, and the sweep picks them up from there.
 *
 * The result is the FIRST part's, so a caller that wants to know whether the answer has gone out
 * right now still finds out right now — with `ok` false when any part is permanently dead, because
 * half an answer having arrived is not the answer having arrived.
 */
export async function sendSequence({ channel, router, conversationId, to, parts, chatId = null, replyTo = null, sendStyle = null, idempotencyKey = null, toOwner = false, log = () => {} }) {
  const texts = [];
  // Each part with the silence marker off (src/plain.js withoutNoReply); a part that was only the
  // marker is no part at all.
  const given = (parts ?? []).map(t => String(t ?? "")).filter(t => t.trim());
  const clean = given.map(t => withoutNoReply(t, { path: "outbox_parts", log })).filter(q => !q.empty).map(q => q.text);
  for (const t of clean) texts.push(await freshRideLinks(t, { conversationId, log }));
  if (!texts.length) return given.length ? { ...NOTHING_LEFT } : { ok: false, error: "there was nothing to send", retryable: false };
  if (texts.length === 1) {
    return await sendDurable({ channel, router, conversationId, to, text: texts[0], chatId, replyTo, sendStyle, idempotencyKey, toOwner, log });
  }

  const base = idempotencyKey || `auto:${channel}:${conversationId}:${to}:${clock.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const rows = [];
  let previous = null;
  for (const [i, text] of texts.entries()) {
    const { row } = db.enqueueOutbound({
      idemKey: `${base}#${i + 1}`, conversationId, channel, address: to, chatId,
      body: text,
      // The effect goes on the last part WITH WORDS in it (src/links.js effectPartIndex): a bare link
      // arriving with confetti on it is an animation on a URL.
      sendStyle: i === effectPartIndex(texts) ? sendStyle : null,
      // The pin names the message this answer is about, and the answer is the first thing to land
      // under it. A second pin under the same bubble would say the same thing twice.
      replyTo: i === 0 ? replyTo : null,
      afterId: previous,
      toOwner, maxAttempts: config.outboxMaxAttempts,
    });
    rows.push(row);
    previous = row.id;
  }
  log({ outbox_sequence: rows.map(r => r.id), conversation: conversationId, parts: texts.length });

  const results = [];
  for (const row of rows) {
    const r = await attempt({ id: row.id, router, log });
    results.push(r);
    // Not sent. Everything behind it is already queued behind it, so the sweep finishes the chain
    // in order; trying the next one now is the one thing that would get them out of order.
    if (!r.ok && !r.silent) break;
  }

  const first = results[0];
  const sentEach = rows.map((r, i) => ({ outbox_id: r.id, sent: !!results[i]?.ok, of: texts.length }));
  const dead = results.find(r => !r.ok && !r.queued && !r.silent);
  // One dead part kills the answer, and `queued` is not set alongside it: the chain cannot finish,
  // and saying "still trying" about something nothing is trying is the lie this is here to avoid.
  if (dead) return { ...first, ok: false, queued: false, error: dead.error, retryable: false, parts: sentEach };
  const pending = results.length < rows.length || results.some(r => r.queued);
  return { ...first, parts: sentEach, ...(pending ? { queued: true } : {}) };
}

/**
 * One attempt at one row. The only place a row goes from `queued` to anything else.
 *
 * Every exit writes the row before it returns, so there is no window where the process could stop
 * and leave a row saying something that is not true.
 */
export async function attempt({ id, router, log = () => {} }) {
  const claimed = db.claimOutbound(id);
  // Somebody else is already sending this one, or it is already finished. Either way, not ours.
  if (!claimed) {
    const now = db.getOutbound(id);
    return { ok: now?.state === "sent", outbox_id: id, skipped: now?.state ?? "gone" };
  }

  let r;
  try {
    const common = {
      channel: claimed.channel, to: claimed.address, text: claimed.body,
      chatId: claimed.chat_id, sendStyle: claimed.send_style ?? null,
      // On the row, like the effect, so a message retried an hour later is still pinned where it
      // was meant to go.
      replyTo: claimed.reply_to ?? null,
    };
    r = claimed.media ? await router.sendNow({ ...common, ...claimed.media }) : await router.sendNow(common);
  } catch (e) {
    // An adapter that throws is a bug, not an answer. Treated as retryable, because the message
    // itself was probably fine and the alternative is losing it to somebody else's mistake.
    r = { ok: false, error: `the ${claimed.channel} adapter threw: ${(e?.message ?? String(e)).split("\n")[0]}`, retryable: true };
  }

  // Only the silence marker once read (src/channels/router.js sendNow): nothing to send, on purpose.
  // Skipped, not failed, so nobody is told a message "never arrived" that was never a message.
  if (!r.ok && r.silent) {
    db.markOutboundSkipped(id);
    log({ outbox: id, skipped: "only NO_REPLY" });
    return { ok: false, silent: true, outbox_id: id };
  }

  if (r.ok) {
    const sent = db.markOutboundSent(id, { messageId: r.delivered?.message_id ?? null });
    // A text out over this channel to the number that failed closes "texts over it are failing".
    // An alert's own text is not evidence: it would close the alert it just announced.
    if (!String(claimed.idem_key ?? "").startsWith(incidents.KEY_PREFIX)) {
      try { incidents.resolve({ prefix: `send:${claimed.channel}:`, addr: claimed.address, how: "texts are going out again" }); } catch { /* never blocks a send */ }
    }
    log({
      outbox: id, sent_to: claimed.address, attempt: claimed.attempts,
      ...(r.delivered?.reply_to ? { reply_to: r.delivered.reply_to } : {}),
      ...(r.delivered?.reply_dropped ? { reply_dropped: r.delivered.reply_dropped } : {}),
    });
    return { ok: true, outbox_id: id, delivered: r.delivered, attempts: sent.attempts };
  }

  // A picture that carries its own words (a welcome card, src/welcome.js) and cannot go for good goes
  // as those words, on the same row, so its place in the chain holds and nothing behind it dies.
  const final = r.retryable !== true || claimed.attempts >= claimed.max_attempts;
  const fallbackText = String(claimed.media?.fallbackText ?? "").trim();
  if (final && fallbackText) {
    db.outboundAsText(id, fallbackText);
    log({ outbox: id, media_failed: (r.error ?? "unknown").split("\n")[0].slice(0, 200), sent_as_text: true });
    return attempt({ id, router, log });
  }

  return settle({ row: claimed, result: r, log });
}

/**
 * A failed attempt → retry, or give up for good.
 *
 * `retryable` comes from the adapter rather than from reading the sentence, so there is one opinion
 * about whether a message is dead. A channel that does not say is treated as not retryable: an
 * unclassified failure retried on a timer is the thing that texts somebody four times.
 */
function settle({ row, result, log }) {
  const why = result.error ?? "it did not go out, and the channel did not say why";
  const key = result.error_key ?? null;
  const code = result.error_code ?? null;
  const canTryAgain = result.retryable === true;

  if (!canTryAgain) {
    db.markOutboundFailed(row.id, { error: why, errorKey: key, errorCode: code });
    log({ outbox: row.id, failed: row.address, why, retryable: false });
    raiseSendFailure(row, { why, key, code, tried: "not retried — the channel said this one cannot go" });
    return { ok: false, outbox_id: row.id, error: why, error_key: key, error_code: code, retryable: false };
  }
  if (row.attempts >= row.max_attempts) {
    const outOf = `${why} (tried ${row.attempts} times)`;
    db.markOutboundFailed(row.id, { error: outOf, errorKey: key, errorCode: code });
    log({ outbox: row.id, failed: row.address, why, attempts: row.attempts, gave_up: true });
    raiseSendFailure(row, { why, key, code, tried: `sent ${row.attempts} times with backoff, then gave up` });
    return { ok: false, outbox_id: row.id, error: outOf, error_key: key, error_code: code, retryable: false, gave_up: true };
  }

  const nextAt = clock.now() + backoffMs(row.attempts);
  db.markOutboundRetry(row.id, { error: why, errorKey: key, errorCode: code, nextAt });
  log({ outbox: row.id, retry_at: nextAt, attempt: row.attempts, of: row.max_attempts, why });
  return { ok: false, outbox_id: row.id, queued: true, error: why, error_key: key, error_code: code, retryable: true, next_attempt_at: nextAt };
}

/**
 * Sendblue's refusals that are about the person, not about Reason: they opted out, or they have not
 * texted the line once yet (the pre-reply limits). Nothing the owner can fix, and on live they are
 * most of a week's failures (10 opt-outs and one unverified contact, 2026-10-18..25).
 */
const ABOUT_THEM = new Set(["OPTED_OUT", "unverified_contact_inferred"]);
export const aboutThem = (key) => ABOUT_THEM.has(key) || String(key ?? "").startsWith("PRE_REPLY_");

/**
 * A text that is never going, as an alert at the moment the outbox gives up on it (src/incidents.js).
 *
 * One alert per channel and error, so twenty texts failing for one reason is one alert counting to
 * twenty. Not raised for: an alert text itself (a dead channel must not alert about its alerts), a
 * refusal about the person (`aboutThem`), or the console.
 */
function raiseSendFailure(row, { why, key = null, code = null, tried = "" }) {
  try {
    if (!row || row.channel === "console") return;
    if (String(row.idem_key ?? "").startsWith(incidents.KEY_PREFIX)) return;
    if (aboutThem(key)) return;
    // Reason's own phone line on the other end is a test talking to itself, not texts failing.
    if (isOwnLine(row.address)) return;
    incidents.raise({
      key: `send:${row.channel}:${key || code || "other"}`, area: "messaging", covers: "outbox",
      what: `texts over ${row.channel} are failing`, addr: row.address ?? "",
      who: `${row.conversation_id}${row.address && !String(row.conversation_id).includes(row.address) ? ` (${row.address})` : ""}, outbox #${row.id}`,
      error: why, tried,
      next: `${row.channel}'s dashboard and its status page; journalctl -u reason for the response`,
    });
  } catch { /* an alert never breaks the outbox */ }
}

/**
 * Rows that were mid-attempt when the last process stopped.
 *
 * Called once, before the first sweep. A `sending` row is a crash by definition, and it is the one
 * state where the honest answer is "I do not know": the HTTP request may have reached Sendblue and
 * the response may have been lost. So nothing is resent here — the row is moved to `unknown` and
 * the next sweep asks the provider what happened.
 */
export function recoverStranded({ log = () => {} } = {}) {
  const rows = db.strandedOutbound();
  for (const row of rows) {
    db.markOutboundUnknown(row.id, {
      error: "the process stopped while this was being sent, so whether it arrived is not known yet",
      nextAt: clock.now(),
    });
  }
  if (rows.length) log({ outbox_stranded: rows.map(r => r.id), note: "asking the channel whether these went out" });
  return rows.map(r => r.id);
}

/**
 * Resolve one `unknown` row by asking the channel whether the message went.
 *
 * The window handed to findSent is the attempt's own: from when the row was created to now. A
 * narrower window than "all time" matters because the same reply text could legitimately have gone
 * to the same person last week, and matching that copy would make Reason silently drop this one.
 */
export async function resolveUnknown({ id, router, log = () => {} }) {
  const row = db.getOutbound(id);
  if (!row || row.state !== "unknown") return { ok: false, skipped: row?.state ?? "gone" };

  // A picture card with its own words (src/welcome.js) and no text to look it up by: the provider
  // cannot say whether it went, and failing it would take every card and question behind it down.
  // It goes as its line instead: at worst they see a card and its line, never a gallery cut short.
  const fallbackText = String(row.media?.fallbackText ?? "").trim();
  if (fallbackText && !String(row.body ?? "").trim()) {
    db.outboundAsText(id, fallbackText);
    log({ outbox: id, resolved: "sent_as_text", why: "stopped mid-send; a picture cannot be looked up" });
    return { ok: true, outbox_id: id, resolved: "queued" };
  }

  const ch = router.get(row.channel);
  if (!ch) {
    db.markOutboundFailed(row.id, { error: `the ${row.channel} channel is not registered any more, so this was never sent and cannot be` });
    return { ok: false, outbox_id: id, resolved: "failed" };
  }

  let found;
  try {
    found = await ch.findSent({ to: row.address, text: row.body, since: row.created_at, until: clock.now() });
  } catch (e) {
    found = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
  }

  if (found?.ok && found.found) {
    db.markOutboundSent(id, { messageId: found.message_id ?? null });
    log({ outbox: id, resolved: "already_sent", message_id: found.message_id ?? null });
    return { ok: true, outbox_id: id, resolved: "sent" };
  }
  if (found?.ok && !found.found) {
    // The provider is sure it does not have it. Safe to send, so it goes back in the queue and
    // keeps the attempts it has already spent.
    db.markOutboundRetry(id, { error: "the last attempt never reached them, so it is going again", nextAt: clock.now() });
    log({ outbox: id, resolved: "never_arrived", requeued: true, ...(found.refused ? { refused: found.refused } : {}) });
    return { ok: true, outbox_id: id, resolved: "queued" };
  }

  // Cannot tell. This is the one place the system chooses to lose a message rather than risk
  // sending it twice, and it says so in those words rather than going quiet.
  const why = `the process stopped while this was being sent and ${row.channel} cannot say whether it arrived, so it was NOT sent again: ${found?.error ?? "no reason given"}`;
  db.markOutboundFailed(id, { error: why });
  log({ outbox: id, resolved: "unknowable", why: found?.error });
  raiseSendFailure(row, { why: found?.error ?? "the process stopped mid-send", key: "unknowable", tried: `asked ${row.channel} whether it arrived; it could not say, so it was not resent` });
  return { ok: false, outbox_id: id, resolved: "failed" };
}

/**
 * One pass: every row that is due, attempted or resolved. Returns what happened, which is what the
 * tests assert on.
 */
export async function pass({ router, log = () => {} } = {}) {
  const out = { tried: 0, sent: 0, requeued: 0, failed: 0, resolved: 0 };
  for (const row of db.dueOutbound()) {
    if (row.state === "unknown") {
      const r = await resolveUnknown({ id: row.id, router, log });
      out.resolved++;
      if (r.resolved === "failed") out.failed++;
      continue;
    }
    out.tried++;
    const r = await attempt({ id: row.id, router, log });
    if (r.ok) out.sent++;
    else if (r.queued) out.requeued++;
    else out.failed++;
  }
  return out;
}

/**
 * What Reason is told, at the top of its next turn, about a reply that never arrived.
 *
 * Written in code rather than left to the model to infer, because the failure mode this exists to
 * prevent is Reason carrying on as though it had replied. It is phrased as a fact plus an
 * instruction, the same way a timer event is: here is what happened, now decide what to say.
 */
export function undeliveredNotice(rows, { ownerName = config.ownerName } = {}) {
  if (!rows.length) return "";
  const lines = rows.map(r => {
    const who = r.to_owner ? "to them" : `to ${r.address}`;
    return `  - the message ${who} saying "${trim(r.body)}" never arrived. ${r.last_error}`;
  });
  const one = rows.length === 1;
  return `[delivery failure] ${one ? "a message you sent" : `${rows.length} messages you sent`} never got there:\n${lines.join("\n")}\n`
    + `Whoever was waiting on ${one ? "it" : "them"} did not see ${one ? "it" : "them"}, so do not talk as though ${one ? "it" : "they"} landed.`
    + ` Own it in one short line and say what you will do instead. If it was to somebody else, ${ownerName === config.ownerName ? "they" : ownerName} may need to reach that person another way.`;
}

/**
 * The line the owner gets about a message to somebody else that never arrived.
 *
 * Code's words, not the model's, for the same reason the task-failure line is: this is a report
 * about Reason's own plumbing failing, and the model is the thing that cannot be trusted to notice.
 */
export function ownerFailureLine(row) {
  return `heads up — that text to ${row.address} never actually went out. ${row.last_error}`
    + ` nothing more is going to it from me. want me to try again or do you want to reach them yourself?`;
}

function trim(s, n = 80) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
